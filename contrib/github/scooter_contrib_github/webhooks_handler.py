"""GitHub webhook handler.

A mention in an issue or PR comment creates or forwards a conversation, the trigger
label creates one, and any comment on a resource with an active conversation is
auto-forwarded.
"""

import asyncio
import httpx
import hashlib
import hmac
import logging

from fastapi import APIRouter, Header, HTTPException, Request

from scooter_webhooks_lib import store as db
from scooter_webhooks_lib.resources import link_variants as _lib_link_variants
from scooter_webhooks_lib.store import PENDING_CONVERSATION_ID, is_pending
from scooter_webhooks_lib.vars import ConversationVars

from .config import settings
from scooter_webhooks_lib.agent_host_client import (
    SendOutcome, conversation_url, create_conversation, deliver_message, push_link, send_message,
)
from scooter_webhooks_lib import policy
from scooter_webhooks_lib.identity import resolve_owner
from scooter_webhooks_lib.reply_workflow import reply_workflow
from scooter_webhooks_lib.sender import Sender
from .responses import get_app_login, post_github_comment
from .senders import actor_on, sender_from

logger = logging.getLogger(__name__)
_C = {"component": "handlers.github"}
router = APIRouter()


def _verify_signature(body: bytes, signature: str) -> bool:
    # Fail closed: an unset secret must not admit forged events.
    if not settings.github_webhook_secret:
        logger.warning("GITHUB_WEBHOOK_SECRET is not set; rejecting the unverifiable delivery", extra=_C)
        return False
    if not signature.startswith("sha256="):
        return False
    expected = hmac.new(
        settings.github_webhook_secret.encode(),
        body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


async def _is_self_authored(actor: dict, body: str) -> bool:
    """Whether this comment or review is machine chatter to drop, including the agent's own comments posted through the same GitHub App."""
    actor = actor or {}
    login = actor.get("login", "")
    if policy.is_ignored_user(login):
        return True
    if policy.is_own_ack(body):
        return True

    own_login = await get_app_login()
    if own_login and login.lower() == own_login.lower():
        return True

    # Without App credentials, drop bot chatter that is not addressed to the agent.
    return (
        policy.ignore_bot_authors()
        and actor.get("type") == "Bot"
        and not policy.mentions_agent(body)
    )


def _resource_id(owner: str, repo: str, number: int) -> str:
    return f"{owner}/{repo}#{number}"


def _link_variants(res_type: str, res_id: str) -> list[tuple[str, str]]:
    """(resource_type, resource_id) pairs to try, widest-compatible first; this package's `resources` module registers github's shapes."""
    return _lib_link_variants("github", res_type, res_id)


async def _resolve_conversation(res_type: str, res_id: str) -> str | None:
    """First conversation matching any known link shape."""
    for rtype, rid in _link_variants(res_type, res_id):
        found = (
            await db.lookup_conversation("github", rtype, rid)
            or await db.get_conversation_for_resource("github", rtype, rid)
        )
        if found:
            return found
    return None


def _reply_steps(comment_id: int | None) -> str:
    return reply_workflow("github_comment", "scooter-github", react=bool(comment_id))


def _response_instructions(
    owner: str, repo: str, number: int, is_pr: bool, comment_id: int | None = None,
) -> str:
    kind = "PR" if is_pr else "issue"
    return (
        f"\n\n---\n"
        f"{_reply_steps(comment_id)}\n\n"
        f"To respond on GitHub {kind} #{number}, use "
        f'`github_comment(body, target="{owner}/{repo}#{number}")`. '
        f"Name the target: this conversation may be linked to more than one PR/issue."
        + _comment_ref(comment_id)
    )


def _comment_ref(comment_id: int | None) -> str:
    """The id of this comment, so a reply or reaction can target it."""
    return f"\n\n(comment_id: {comment_id})" if comment_id else ""


def _format_forwarded_message(
    comment_body: str, owner: str, repo: str, number: int,
    is_pr: bool, has_mention: bool, comment_id: int | None = None,
) -> str:
    kind = "pull request" if is_pr else "issue"

    if has_mention:
        preamble = f"You were mentioned in a comment on GitHub {kind} #{number} in {owner}/{repo}."
    else:
        preamble = (
            f"A new comment was posted on GitHub {kind} #{number} in {owner}/{repo}. "
            f"Respond only if it is addressed to you or asks for something."
        )

    reply_instruction = (
        f"{_reply_steps(comment_id)}\n\n"
        f'To respond, use `github_comment(body, target="{owner}/{repo}#{number}")`. '
        "Name the target: this conversation may be linked to more than one PR/issue. "
        "It reports the real result and where the comment landed."
    )
    reply_instruction += _comment_ref(comment_id)

    return f"{preamble}\n\n---\n\n{comment_body}\n\n---\n\n{reply_instruction}"


def _event_owner(payload: dict) -> str:
    """The lowercased account an event belongs to."""
    repo_owner = ((payload.get("repository") or {}).get("owner") or {}).get("login")
    account = ((payload.get("installation") or {}).get("account") or {}).get("login")
    return (repo_owner or account or "").lower()


@router.post("/webhooks/github")
async def handle_github_webhook(
    request: Request,
    x_github_event: str = Header(""),
    x_hub_signature_256: str = Header(""),
):
    """Receive GitHub webhook events."""
    if not settings.github_enabled:
        return {"status": "disabled"}

    body = await request.body()
    if not _verify_signature(body, x_hub_signature_256):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    payload = await request.json()
    event_type = x_github_event

    owner = _event_owner(payload)
    if settings.app_owners and owner not in settings.app_owners:
        # A public App's other installations share our webhook.
        logger.info("ignoring event from another account", extra={**_C, "source": "github", "owner": owner})
        return {"status": "ignored"}

    logger.info("received event", extra={**_C, "source": "github", "event_type": event_type})

    if event_type == "issue_comment":
        await _handle_comment(payload)
    elif event_type == "pull_request_review_comment":
        await _handle_review_comment(payload)
    elif event_type == "pull_request_review":
        await _handle_review(payload)
    elif event_type == "workflow_run":
        await _handle_workflow_run(payload)
    elif event_type == "issues":
        await _handle_issue_event(payload)
    elif event_type == "pull_request":
        await _handle_pr_event(payload)
    elif event_type == "push":
        await _handle_push(payload)
    else:
        logger.debug("ignoring event type", extra={**_C, "source": "github", "event_type": event_type})

    return {"status": "ok"}


async def _handle_comment(payload: dict):
    """Handle issue_comment event (works for both issues and PRs)."""
    action = payload.get("action", "")
    if action != "created":
        return

    comment = payload.get("comment", {})
    comment_body = comment.get("body", "")
    author = comment.get("user", {})
    user = author.get("login", "unknown")
    issue = payload.get("issue", {})
    issue_number = issue.get("number")
    issue_title = issue.get("title", "")
    is_pr = "pull_request" in issue

    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")

    if await _is_self_authored(author, comment_body):
        return
    sender = sender_from(author, comment.get("author_association"))

    has_mention = policy.mentions_agent(comment_body)
    res_type = "pull_request" if is_pr else "issue"
    res_id = _resource_id(owner, repo, issue_number)

    existing = await _resolve_conversation(res_type, res_id)

    if not has_mention and not existing:
        return

    message_text = policy.strip_mention(comment_body)
    comment_text = f"@{user} commented:\n\n{message_text}"

    comment_id = comment.get("id")

    if is_pending(existing):
        forward_msg = _format_forwarded_message(
            comment_text, owner, repo, issue_number, is_pr, has_mention, comment_id,
        )
        await db.store_pending_message("github", res_type, res_id, forward_msg, sender)
        return

    if existing:
        forward_msg = _format_forwarded_message(
            comment_text, owner, repo, issue_number, is_pr, has_mention, comment_id,
        )
        outcome = await deliver_message(existing, forward_msg, source="github", sender=sender)
        if outcome is not SendOutcome.NOT_FOUND:
            # The conversation still exists, so a failed run keeps its mapping (issue #802).
            if outcome is not SendOutcome.DELIVERED:
                logger.warning(
                    "forward to existing conversation failed, keeping it",
                    extra={
                        **_C,
                        "conversation_id": existing,
                        "outcome": outcome.value,
                        "source": "github",
                        "resource_type": res_type,
                        "resource_id": res_id,
                    },
                )
            return
        logger.warning(
            "existing conversation no longer exists, creating a new one",
            extra={
                **_C,
                "conversation_id": existing,
                "source": "github",
                "resource_type": res_type,
                "resource_id": res_id,
            },
        )

    await db.store_conversation("github", res_type, res_id, PENDING_CONVERSATION_ID)

    kind = "PR" if is_pr else "Issue"
    conv_title = f"{kind} #{issue_number}: {issue_title}"
    full_repo = f"{owner}/{repo}"

    reply_hint = _response_instructions(owner, repo, issue_number, is_pr, comment_id)
    context = f"Context: {kind} #{issue_number} '{issue_title}' in {full_repo}"
    full_message = f"{context}\n\n{comment_text}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            res_type=res_type, res_id=res_id,
            message=full_message, repo=full_repo, conv_title=conv_title,
            owner=owner, repo_name=repo, issue_number=issue_number,
            invoking_user=user, sender=sender,
        )
    )


async def _forward_or_ignore(res_id: str, message: str, sender: Sender | None) -> None:
    """Forward at interrupt priority to the conversation linked to this PR, or do nothing; a PR the agent does not own is not ours to act on."""
    existing = await _resolve_conversation("pull_request", res_id)
    if not existing or is_pending(existing):
        return
    await send_message(existing, message, priority=True, source="github", sender=sender)


def _line_ref(comment: dict) -> str:
    """`path:line`, or just the path when GitHub gives no line."""
    path = comment.get("path", "")
    line = comment.get("line") or comment.get("original_line")
    return f"{path}:{line}" if line else path


async def _handle_review_comment(payload: dict):
    """pull_request_review_comment: a comment on a specific line of the diff."""
    if payload.get("action") != "created":
        return

    comment = payload.get("comment", {})
    body = comment.get("body", "")
    author = comment.get("user", {})
    user = author.get("login", "unknown")
    if await _is_self_authored(author, body):
        return

    pr = payload.get("pull_request", {})
    number = pr.get("number")
    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")

    where = _line_ref(comment)
    hunk = comment.get("diff_hunk", "")
    comment_id = comment.get("id")
    threaded = comment.get("in_reply_to_id") is not None

    message = (
        f"@{user} commented on a specific LINE of PR #{number} in {owner}/{repo}"
        f"{' (replying in an existing thread)' if threaded else ''}:\n\n"
        f"**{where}**\n\n"
        + (f"```diff\n{hunk}\n```\n\n" if hunk else "")
        + f"{body}\n\n---\n\n"
        f"{_reply_steps(comment_id)}\n\n"
        f"This is a LINE comment, so reply IN THE THREAD: "
        f"`github_comment(body, in_reply_to={comment_id})`. That puts your answer next to "
        f"the code being discussed. Use `github_comment(body, target=\"{owner}/{repo}#{number}\")` only for something "
        f"about the PR as a whole.\n\n"
        f"If the comment asks for a change, make it and push — a reply alone does not "
        f"address it."
        + _comment_ref(comment_id)
    )
    sender = sender_from(author, comment.get("author_association"))
    await _forward_or_ignore(_resource_id(owner, repo, number), message, sender)


async def _handle_review(payload: dict):
    """pull_request_review: the review envelope (approved / changes_requested)."""
    if payload.get("action") != "submitted":
        return

    review = payload.get("review", {})
    author = review.get("user", {})
    user = author.get("login", "unknown")
    body = (review.get("body") or "").strip()
    state = (review.get("state") or "").lower()
    if await _is_self_authored(author, body):
        return

    pr = payload.get("pull_request", {})
    number = pr.get("number")
    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")

    # The individual line comments arrive as their own events.
    if state == "approved":
        head = f"@{user} APPROVED PR #{number} in {owner}/{repo}."
        tail = "No action needed unless the body asks for something."
    elif state == "changes_requested":
        head = f"@{user} requested CHANGES on PR #{number} in {owner}/{repo}."
        tail = (
            "Comment your plan once, then address the line comments (they arrive separately) "
            "and PUSH — a reply alone does not clear a changes-requested review."
        )
    else:
        head = f"@{user} reviewed PR #{number} in {owner}/{repo}."
        tail = (
            f'Respond with `github_comment(body, target="{owner}/{repo}#{number}")` '
            "if it asks for something."
        )

    message = f"{head}\n\n" + (f"{body}\n\n" if body else "") + f"---\n\n{tail}"
    sender = sender_from(author, review.get("author_association"))
    await _forward_or_ignore(_resource_id(owner, repo, number), message, sender)


async def _previous_run_failed(owner: str, repo: str, workflow_id, branch: str, before_id: int) -> bool:
    """Whether the previous run of this workflow on this branch failed, answering False on any error."""
    try:
        from .responses import _headers_for_repo, GITHUB_API

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
                headers=await _headers_for_repo(owner, repo),
                params={"branch": branch, "per_page": 5, "status": "completed"},
            )
            resp.raise_for_status()
            runs = resp.json().get("workflow_runs", [])
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "previous-run lookup failed; treating as not-previously-red",
            extra={**_C, "source": "github", "error": str(e)},
        )
        return False
    for r in runs:
        if r.get("id") == before_id:
            continue
        return r.get("conclusion") == "failure"
    return False


async def _fork_pr_number(owner: str, repo: str, run: dict) -> int | None:
    """The open PR a fork's run belongs to, or None; GitHub omits it for forks."""
    head_owner = (run.get("head_repository") or {}).get("owner", {}).get("login", "")
    branch = run.get("head_branch", "")
    if not head_owner or not branch or head_owner == owner:
        return None
    try:
        from .responses import _headers_for_repo, GITHUB_API

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/pulls",
                headers=await _headers_for_repo(owner, repo),
                params={"head": f"{head_owner}:{branch}", "state": "open"},
            )
            resp.raise_for_status()
            pulls = resp.json()
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "fork PR lookup failed; dropping the CI event",
            extra={**_C, "source": "github", "error": str(e), "branch": f"{head_owner}:{branch}"},
        )
        return None
    for pr in pulls:
        if pr.get("head", {}).get("sha") == run.get("head_sha"):
            return pr.get("number")
    return None


async def _handle_workflow_run(payload: dict):
    """workflow_run: CI finished, forwarded on failure, on any re-run, and on a success after a red run."""
    if payload.get("action") != "completed":
        return

    run = payload.get("workflow_run", {})
    conclusion = run.get("conclusion")
    if conclusion not in ("failure", "success"):
        return

    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")

    prs = run.get("pull_requests") or []
    number = prs[0].get("number") if prs else await _fork_pr_number(owner, repo, run)
    if not number:
        return

    name = run.get("name", "workflow")
    url = run.get("html_url", "")
    branch = run.get("head_branch", "")

    rerun = (run.get("run_attempt") or 1) > 1
    if conclusion == "success":
        # A re-run keeps its run id, so the previous-run lookup can't judge it.
        if not rerun and not await _previous_run_failed(owner, repo, run.get("workflow_id"), branch, run.get("id")):
            return
        why = "The re-run passed" if rerun else "The previous run failed"
        message = (
            f"CI is GREEN: **{name}** passes on `{branch}` (PR #{number}).\n\n"
            f"{url}\n\n---\n\n{why}, so this unblocks the PR. "
            f"No action needed unless you were waiting to do something after CI."
        )
    else:
        failed = await _failed_jobs(owner, repo, run.get("id"))
        listed = ("\n".join(f"- {j}" for j in failed)) if failed else "- (job names unavailable)"
        message = (
            f"CI FAILED: **{name}** on `{branch}` (PR #{number}).\n\n"
            f"Failing jobs:\n{listed}\n\n{url}\n\n---\n\n"
            f"Investigate before pushing again — read the failing job's log rather than "
            f"guessing. If it is a known flake, say so explicitly rather than silently "
            f"re-running."
        )
    await _forward_or_ignore(_resource_id(owner, repo, number), message, None)


async def _failed_jobs(owner: str, repo: str, run_id) -> list[str]:
    """Names of the jobs that failed in a run."""
    try:
        from .responses import _headers_for_repo, GITHUB_API

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/actions/runs/{run_id}/jobs",
                headers=await _headers_for_repo(owner, repo),
                params={"filter": "latest", "per_page": 100},
            )
            resp.raise_for_status()
            jobs = resp.json().get("jobs", [])
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "failed-jobs lookup failed; forwarding without job names",
            extra={**_C, "source": "github", "error": str(e)},
        )
        return []
    return [j.get("name", "?") for j in jobs if j.get("conclusion") == "failure"]


async def _handle_issue_event(payload: dict):
    """Handle issues event (labeled)."""
    action = payload.get("action", "")
    if action != "labeled":
        return

    label = payload.get("label", {}).get("name", "")
    if not policy.is_trigger_label(label):
        return

    issue = payload.get("issue", {})
    issue_number = issue.get("number")
    issue_title = issue.get("title", "")
    issue_body = issue.get("body", "") or ""
    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")
    full_repo = f"{owner}/{repo}"
    res_id = _resource_id(owner, repo, issue_number)

    await db.store_conversation("github", "issue", res_id, PENDING_CONVERSATION_ID)

    reply_hint = _response_instructions(owner, repo, issue_number, is_pr=False)
    message = f"Issue #{issue_number} '{issue_title}' in {full_repo}\n\n{issue_body}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            res_type="issue", res_id=res_id,
            message=message, repo=full_repo,
            conv_title=f"Issue #{issue_number}: {issue_title}",
            owner=owner, repo_name=repo, issue_number=issue_number,
            invoking_user=payload.get("sender", {}).get("login"),
            sender=actor_on(payload, issue),
        )
    )


async def _handle_pr_closed(payload: dict):
    """pull_request closed: tell the linked conversation it was merged or closed."""
    pr = payload.get("pull_request", {})
    number = pr.get("number")
    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")
    sender = payload.get("sender", {}).get("login", "unknown")

    if pr.get("merged"):
        by = (pr.get("merged_by") or {}).get("login") or sender
        base = pr.get("base", {}).get("ref", "")
        sha = pr.get("merge_commit_sha") or ""
        message = (
            f"PR #{number} in {owner}/{repo} was MERGED by @{by}"
            + (f" into `{base}`" if base else "")
            + (f" ({sha[:12]})" if sha else "")
            + ".\n\n---\n\nThe branch is done: do not push more commits to it. "
            f"Follow-up work needs a new branch off the updated `{base or 'base'}`."
        )
    else:
        message = (
            f"PR #{number} in {owner}/{repo} was CLOSED WITHOUT MERGING by @{sender}.\n\n---\n\n"
            f"Stop work on this PR unless asked otherwise. Check the thread for why it was closed."
        )
    await _forward_or_ignore(_resource_id(owner, repo, number), message, actor_on(payload, pr))


_DEQUEUE_HINTS = {
    "failed_checks": "CI failed on the merge group: find the failing check, fix it and push.",
    "merge_conflict": "It conflicts with the queue ahead of it: rebase on the base branch and push.",
    "manual": "Someone removed it by hand: check the thread for why before doing anything.",
}


async def _handle_pr_dequeued(payload: dict):
    """pull_request dequeued: tell the linked conversation its PR left the merge queue unmerged."""
    reason = (payload.get("reason") or "unknown").lower()
    if reason in ("merged", "merge"):
        return
    pr = payload.get("pull_request", {})
    number = pr.get("number")
    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")
    sender = payload.get("sender", {}).get("login", "unknown")
    hint = _DEQUEUE_HINTS.get(reason, "Find out why from the PR and its merge-group checks.")
    message = (
        f"PR #{number} in {owner}/{repo} was REMOVED FROM THE MERGE QUEUE "
        f"(reason: {reason}, by @{sender}).\n\n---\n\n"
        f"{hint} It must be queued again to merge."
    )
    await _forward_or_ignore(_resource_id(owner, repo, number), message, actor_on(payload, pr))


# Seconds to wait before each mergeability read, while GitHub recomputes it.
_MERGEABLE_DELAYS = (2, 4, 8, 16)


async def _pull(owner: str, repo: str, number: int) -> dict | None:
    """The PR's REST representation once its mergeability is known, or None."""
    from .responses import _headers_for_repo, GITHUB_API

    async with httpx.AsyncClient(timeout=15) as client:
        for delay in _MERGEABLE_DELAYS:
            await asyncio.sleep(delay)
            resp = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/pulls/{number}",
                headers=await _headers_for_repo(owner, repo),
            )
            resp.raise_for_status()
            pr = resp.json()
            if pr.get("mergeable") is not None:
                return pr
    return None


async def _notify_if_conflicting(owner: str, repo: str, number: int) -> None:
    """Tell a linked PR's conversation it conflicts with its base, once per head commit."""
    res_id = _resource_id(owner, repo, number)
    conversation = await _resolve_conversation("pull_request", res_id)
    if not conversation or is_pending(conversation):
        return
    try:
        pr = await _pull(owner, repo, number)
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "mergeability lookup failed",
            extra={**_C, "source": "github", "resource_id": res_id, "error": str(e)},
        )
        return
    if pr is None or pr.get("mergeable") is not False or pr.get("state") != "open":
        return
    head = pr.get("head", {}).get("sha", "")
    if not await ConversationVars(conversation, "github").claim(f"conflict_head:{res_id}", head):
        return
    base = pr.get("base", {}).get("ref", "base")
    message = (
        f"PR #{number} in {owner}/{repo} now has MERGE CONFLICTS with `{base}`.\n\n---\n\n"
        f"Rebase the branch on the latest `{base}`, resolve the conflicts, and push "
        f"(`git push --force-with-lease`)."
    )
    await send_message(conversation, message, source="github")


async def _check_pulls_into(owner: str, repo: str, base: str) -> None:
    """Check every open PR into `base` for a new conflict."""
    try:
        from .responses import _headers_for_repo, GITHUB_API

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/pulls",
                headers=await _headers_for_repo(owner, repo),
                params={"base": base, "state": "open", "per_page": 100},
            )
            resp.raise_for_status()
            pulls = resp.json()
    except Exception as e:  # noqa: BLE001
        logger.warning(
            "open-PR lookup failed; skipping the conflict check",
            extra={**_C, "source": "github", "base": base, "error": str(e)},
        )
        return
    await asyncio.gather(*(_notify_if_conflicting(owner, repo, p["number"]) for p in pulls))


async def _handle_push(payload: dict):
    """push: a moved branch can make the PRs into it conflict, which GitHub never announces."""
    ref = payload.get("ref", "")
    if payload.get("deleted") or not ref.startswith("refs/heads/"):
        return
    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")
    # Mergeability takes seconds to settle, longer than GitHub waits for a reply.
    asyncio.create_task(_check_pulls_into(owner, repo, ref.removeprefix("refs/heads/")))


async def _handle_pr_event(payload: dict):
    """Handle pull_request event (labeled, closed, dequeued, synchronize)."""
    action = payload.get("action", "")
    if action == "synchronize":
        pr = payload.get("pull_request", {})
        repo_data = payload.get("repository", {})
        asyncio.create_task(_notify_if_conflicting(
            repo_data.get("owner", {}).get("login", ""), repo_data.get("name", ""), pr.get("number"),
        ))
        return
    if action == "closed":
        await _handle_pr_closed(payload)
        return
    if action == "dequeued":
        await _handle_pr_dequeued(payload)
        return
    if action != "labeled":
        return

    label = payload.get("label", {}).get("name", "")
    if not policy.is_trigger_label(label):
        return

    pr = payload.get("pull_request", {})
    pr_number = pr.get("number")
    pr_title = pr.get("title", "")
    pr_body = pr.get("body", "") or ""
    source_branch = pr.get("head", {}).get("ref", "")
    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")
    full_repo = f"{owner}/{repo}"
    res_id = _resource_id(owner, repo, pr_number)

    await db.store_conversation("github", "pull_request", res_id, PENDING_CONVERSATION_ID)

    reply_hint = _response_instructions(owner, repo, pr_number, is_pr=True)
    message = f"PR #{pr_number} '{pr_title}' (branch: {source_branch}) in {full_repo}\n\n{pr_body}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            res_type="pull_request", res_id=res_id,
            message=message, repo=full_repo,
            conv_title=f"PR #{pr_number}: {pr_title}",
            owner=owner, repo_name=repo, issue_number=pr_number,
            invoking_user=payload.get("sender", {}).get("login"),
            sender=actor_on(payload, pr),
        )
    )


async def _background_create_conversation(
    res_type: str, res_id: str, message: str, repo: str,
    conv_title: str, owner: str, repo_name: str,
    issue_number: int, invoking_user: str | None = None,
    sender: Sender | None = None,
) -> None:
    # Runs pre-run, since create_conversation blocks until the whole agent turn finishes.
    async def _register(conv_id: str) -> None:
        await db.store_conversation("github", res_type, res_id, conv_id)
        gh_kind = "pull" if res_type == "pull_request" else "issues"
        await push_link(
            conv_id, source="github", resource_type=res_type,
            url=f"https://{settings.github_host}/{owner}/{repo_name}/{gh_kind}/{issue_number}",
            title=f"{owner}/{repo_name} #{issue_number}",
            ref={"owner": owner, "repo": repo_name, "number": issue_number},
        )
        await post_github_comment(
            owner=owner, repo=repo_name, issue_number=issue_number,
            body=f"Scooter is on it — follow along: [View conversation]({conversation_url(conv_id)})",
        )

    # Best-effort owner lookup; None leaves the conversation unowned.
    conv_owner = await resolve_owner("github", invoking_user) if invoking_user else None

    try:
        result = await create_conversation(
            message, repository=repo, git_provider="github", title=conv_title, on_created=_register,
            owner=conv_owner, source="github", sender=sender,
        )
        if not result:
            await _clear_pending(res_type, res_id)
            # Correct the optimistic comment already posted in _register.
            await post_github_comment(
                owner=owner, repo=repo_name, issue_number=issue_number,
                body="…actually, Scooter couldn't start on this one — failed to create the conversation.",
            )
            return

        if result.get("interrupted"):
            # The agent-host resumes the interrupted run on boot, so neither post a failure nor flush pending.
            return

        if result.get("errored"):
            # The conversation exists and did work, so this is an error partway through, not a failed start.
            await _clear_pending(res_type, res_id)
            conv_id = result.get("conversation_id", "")
            await post_github_comment(
                owner=owner, repo=repo_name, issue_number=issue_number,
                body=f"Scooter hit an error partway through — see the [conversation]({conversation_url(conv_id)}) for details.",
            )
            return

        conv_id = result.get("conversation_id", "")

        messages = await db.get_and_clear_pending_messages("github", res_type, res_id)
        for msg, msg_sender in messages:
            ok = await send_message(conv_id, msg, source="github", sender=msg_sender)
            if not ok:
                logger.warning(
                    "flush of pending message failed",
                    extra={**_C, "conversation_id": conv_id, "source": "github", "resource_id": res_id},
                )
    except Exception:
        await _clear_pending(res_type, res_id)
        logger.exception(
            "background conversation creation failed",
            extra={**_C, "source": "github", "resource_type": res_type, "resource_id": res_id},
        )


async def _clear_pending(res_type: str, res_id: str) -> None:
    existing = await db.lookup_conversation("github", res_type, res_id)
    if is_pending(existing):
        await db.clear_conversation("github", res_type, res_id)
    await db.get_and_clear_pending_messages("github", res_type, res_id)


# Discovered and mounted by the webhooks service via the entry-point registry; the handler self-gates in-route.
from scooter_webhooks_lib.registry import WebhookHandler, register_webhook

# Imported for their registration side effects.
from . import identity  # noqa: F401
from . import resources  # noqa: F401


@register_webhook
def github() -> WebhookHandler:
    return WebhookHandler(name="github", router=router)
