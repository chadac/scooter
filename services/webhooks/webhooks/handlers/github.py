"""GitHub webhook handler.

Trigger rules:
- @openhands mention in issue/PR comment -> creates/forwards conversation
- 'openhands' label added to issue/PR -> creates conversation
- Any comment on resource with active conversation -> auto-forwarded
"""

import asyncio
import httpx
import hashlib
import hmac
import logging
import re

from fastapi import APIRouter, Header, HTTPException, Request

from .. import store as db
from ..store import PENDING_CONVERSATION_ID, is_pending

from ..config import settings
from ..agent_host_client import conversation_url, create_conversation, push_link, send_message
from ..identity_resolve import resolve_owner
from ..responses.github import post_github_comment

logger = logging.getLogger(__name__)
_C = {"component": "handlers.github"}
router = APIRouter()


def _verify_signature(body: bytes, signature: str) -> bool:
    if not settings.github_webhook_secret:
        return True
    if not signature.startswith("sha256="):
        return False
    expected = hmac.new(
        settings.github_webhook_secret.encode(),
        body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(f"sha256={expected}", signature)


def _contains_mention(text: str) -> bool:
    return settings.mention_pattern.lower() in text.lower()


def _is_ignored_user(username: str) -> bool:
    if not settings.ignore_usernames:
        return False
    ignored = {u.strip().lower() for u in settings.ignore_usernames.split(",")}
    return username.lower() in ignored


def _is_own_comment(body: str) -> bool:
    # Recognize Scooter's own comments; keep matching the legacy "OpenHands"
    # markers so in-flight threads created before the rename still match.
    return (
        body.startswith("Scooter is on it")
        or body.startswith("OpenHands is working on this.")
        or "OpenHands status:" in body
    )


def _resource_id(owner: str, repo: str, number: int) -> str:
    return f"{owner}/{repo}#{number}"


def _link_variants(res_type: str, res_id: str) -> list[tuple[str, str]]:
    """(resource_type, resource_id) pairs to try, widest-compatible first.

    Links are WRITTEN by the agent through agent-host's /links as
    ("pr"|"issue", <html_url>), but this handler asks for
    ("pull_request"|"issue", "owner/repo#N"). Both halves differ, so an exact
    match never hit and every linked-PR forward was dropped silently. The store
    is the source of truth; derive its shape here rather than rewriting rows.
    """
    out = [(res_type, res_id)]
    m = re.fullmatch(r"([^/]+)/([^#]+)#(\d+)", res_id)
    if m:
        owner, repo, number = m.groups()
        kind, path = ("pr", "pull") if res_type == "pull_request" else ("issue", "issues")
        out.append((kind, f"https://github.com/{owner}/{repo}/{path}/{number}"))
    return out


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


def _response_instructions(owner: str, repo: str, number: int, is_pr: bool) -> str:
    kind = "PR" if is_pr else "issue"
    return (
        f"\n\n---\n"
        f"**Response workflow:** First, post an acknowledgment on GitHub so the requester knows you've seen it. "
        f"Then work on the task. When finished, post a follow-up comment with your results.\n\n"
        f"To respond on GitHub {kind} #{number}, use the `github_comment` tool with your comment `body` — "
        f"the target ({owner}/{repo} #{number}) is already known."
    )


def _format_forwarded_message(
    comment_body: str, owner: str, repo: str, number: int,
    is_pr: bool, has_mention: bool,
) -> str:
    kind = "pull request" if is_pr else "issue"

    if has_mention:
        preamble = (
            f"You were mentioned in a comment on GitHub {kind} #{number} in {owner}/{repo}. "
            f"First, post an acknowledgment so the requester knows you've seen it. "
            f"Then work on the task. When finished, post a follow-up comment with your results."
        )
    else:
        preamble = (
            f"A new comment was posted on GitHub {kind} #{number} in {owner}/{repo}. "
            f"This is for your awareness -- no action is required unless the comment explicitly asks you to do something."
        )

    reply_instruction = (
        "To respond, use the `github_comment` tool (this PR/issue is already known — "
        "you just provide the comment body). It reports the real result."
    )

    return f"{preamble}\n\n---\n\n{comment_body}\n\n---\n\n{reply_instruction}"


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
    user = comment.get("user", {}).get("login", "unknown")
    issue = payload.get("issue", {})
    issue_number = issue.get("number")
    issue_title = issue.get("title", "")
    is_pr = "pull_request" in issue

    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")

    if _is_ignored_user(user):
        return
    if _is_own_comment(comment_body):
        return

    has_mention = _contains_mention(comment_body)
    res_type = "pull_request" if is_pr else "issue"
    res_id = _resource_id(owner, repo, issue_number)

    existing = await _resolve_conversation(res_type, res_id)

    if not has_mention and not existing:
        return

    message_text = comment_body.replace(settings.mention_pattern, "").strip()
    comment_text = f"@{user} commented:\n\n{message_text}"

    if is_pending(existing):
        forward_msg = _format_forwarded_message(
            comment_text, owner, repo, issue_number, is_pr, has_mention,
        )
        await db.store_pending_message("github", res_type, res_id, forward_msg)
        return

    if existing:
        forward_msg = _format_forwarded_message(
            comment_text, owner, repo, issue_number, is_pr, has_mention,
        )
        ok = await send_message(existing, forward_msg, priority=has_mention, source="github")
        if ok:
            return
        logger.warning(
            "send to existing conversation failed, creating a new one",
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

    reply_hint = _response_instructions(owner, repo, issue_number, is_pr)
    context = f"Context: {kind} #{issue_number} '{issue_title}' in {full_repo}"
    full_message = f"{context}\n\n{comment_text}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            res_type=res_type, res_id=res_id,
            message=full_message, repo=full_repo, conv_title=conv_title,
            owner=owner, repo_name=repo, issue_number=issue_number,
            invoking_user=user,
        )
    )


async def _forward_or_ignore(res_id: str, message: str) -> None:
    """Forward to the conversation LINKED to this PR, or do nothing.

    Unlike _handle_comment there is no create-a-conversation path and no mention
    gate: a review comment on a PR the agent opened is addressed to it by
    construction, and a review comment on a PR it does NOT own is not ours to act
    on. priority=True so it preempts a run in progress — the agent-host turns that
    into interrupt:"thinking" (idle generation yields; an in-flight tool call
    finishes first).
    """
    existing = await _resolve_conversation("pull_request", res_id)
    if not existing or is_pending(existing):
        return
    await send_message(existing, message, priority=True, source="github")


def _line_ref(comment: dict) -> str:
    """`path:line`, or just the path when GitHub gives no line (an outdated diff)."""
    path = comment.get("path", "")
    line = comment.get("line") or comment.get("original_line")
    return f"{path}:{line}" if line else path


async def _handle_review_comment(payload: dict):
    """pull_request_review_comment — a comment on a SPECIFIC LINE of the diff."""
    if payload.get("action") != "created":
        return

    comment = payload.get("comment", {})
    body = comment.get("body", "")
    user = comment.get("user", {}).get("login", "unknown")
    if _is_ignored_user(user) or _is_own_comment(body):
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
        f"This is a LINE comment, so reply IN THE THREAD: "
        f"`github_comment(body, in_reply_to={comment_id})`. That puts your answer next to "
        f"the code being discussed. Use a plain `github_comment(body)` only for something "
        f"about the PR as a whole.\n\n"
        f"If the comment asks for a change, make it and push — a reply alone does not "
        f"address it."
    )
    await _forward_or_ignore(_resource_id(owner, repo, number), message)


async def _handle_review(payload: dict):
    """pull_request_review — the review ENVELOPE (approved / changes_requested)."""
    if payload.get("action") != "submitted":
        return

    review = payload.get("review", {})
    user = review.get("user", {}).get("login", "unknown")
    body = (review.get("body") or "").strip()
    state = (review.get("state") or "").lower()
    if _is_ignored_user(user) or _is_own_comment(body):
        return

    pr = payload.get("pull_request", {})
    number = pr.get("number")
    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")

    # The individual line comments arrive as their own events; this is the summary.
    if state == "approved":
        head = f"@{user} APPROVED PR #{number} in {owner}/{repo}."
        tail = "No action needed unless the body asks for something."
    elif state == "changes_requested":
        head = f"@{user} requested CHANGES on PR #{number} in {owner}/{repo}."
        tail = (
            "Address the individual line comments (they arrive separately), then PUSH — "
            "a reply alone does not clear a changes-requested review."
        )
    else:
        head = f"@{user} reviewed PR #{number} in {owner}/{repo}."
        tail = "Respond with `github_comment` if it asks for something."

    message = f"{head}\n\n" + (f"{body}\n\n" if body else "") + f"---\n\n{tail}"
    await _forward_or_ignore(_resource_id(owner, repo, number), message)


async def _previous_run_failed(owner: str, repo: str, workflow_id, branch: str, before_id: int) -> bool:
    """Did the PREVIOUS run of this workflow on this branch fail?

    Queried from the API rather than kept in a table: webhooks holds no per-resource
    state, and "was the last run red?" is exactly that. One round-trip, and on any
    error we answer False — a missed red->green notice is better than a spurious one.
    """
    try:
        from ..responses.github import _headers_for_repo, GITHUB_API

        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs",
                headers=await _headers_for_repo(owner, repo),
                params={"branch": branch, "per_page": 5, "status": "completed"},
            )
            resp.raise_for_status()
            runs = resp.json().get("workflow_runs", [])
    except Exception as e:  # noqa: BLE001 - never let this break the webhook
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


async def _handle_workflow_run(payload: dict):
    """workflow_run — CI finished.

    NOT check_run: that fires at created/in_progress/completed for every job (109 on
    one real commit here, ~300 webhooks per push) and arrives over minutes, so the
    bridge's queue coalescing cannot merge it. workflow_run is one event per workflow.

    Forwarded on FAILURE, and on success only when the previous run was red — so the
    agent learns it is unblocked without polling, and a routinely-green push costs
    nothing.
    """
    if payload.get("action") != "completed":
        return

    run = payload.get("workflow_run", {})
    conclusion = run.get("conclusion")
    if conclusion not in ("failure", "success"):
        return  # cancelled / skipped / timed_out: not actionable

    prs = run.get("pull_requests") or []
    if not prs:
        return  # not a PR run — nothing to route it to
    number = prs[0].get("number")

    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")
    name = run.get("name", "workflow")
    url = run.get("html_url", "")
    branch = run.get("head_branch", "")

    if conclusion == "success":
        if not await _previous_run_failed(owner, repo, run.get("workflow_id"), branch, run.get("id")):
            return
        message = (
            f"CI is GREEN again: **{name}** now passes on `{branch}` (PR #{number}).\n\n"
            f"{url}\n\n---\n\nThe previous run failed, so this unblocks the PR. "
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
    await _forward_or_ignore(_resource_id(owner, repo, number), message)


async def _failed_jobs(owner: str, repo: str, run_id) -> list[str]:
    """Names of the jobs that failed in a run — the useful half of a CI failure."""
    try:
        from ..responses.github import _headers_for_repo, GITHUB_API

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
    if label.lower() != settings.label_trigger.lower():
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
        )
    )


async def _handle_pr_event(payload: dict):
    """Handle pull_request event (labeled)."""
    action = payload.get("action", "")
    if action != "labeled":
        return

    label = payload.get("label", {}).get("name", "")
    if label.lower() != settings.label_trigger.lower():
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
        )
    )


async def _background_create_conversation(
    res_type: str, res_id: str, message: str, repo: str,
    conv_title: str, owner: str, repo_name: str,
    issue_number: int, invoking_user: str | None = None,
) -> None:
    # Register the mapping + link AND post the "on it — follow along" comment
    # BEFORE the agent runs. create_conversation blocks until the whole turn
    # finishes, so doing this after it returned delayed the link comment by the
    # entire run (the 5-10min lag). Everything here needs only conv_id (known in
    # the hook), so fire it pre-run.
    async def _register(conv_id: str) -> None:
        await db.store_conversation("github", res_type, res_id, conv_id)
        gh_kind = "pull" if res_type == "pull_request" else "issues"
        await push_link(
            conv_id, source="github", resource_type=res_type,
            url=f"https://github.com/{owner}/{repo_name}/{gh_kind}/{issue_number}",
            title=f"{owner}/{repo_name} #{issue_number}",
            ref={"owner": owner, "repo": repo_name, "number": issue_number},
        )
        await post_github_comment(
            owner=owner, repo=repo_name, issue_number=issue_number,
            body=f"Scooter is on it — follow along: [View conversation]({conversation_url(conv_id)})",
        )

    # Map the invoking GitHub user -> their Scooter user (by public email) so the
    # conversation gets a real owner. Best-effort -> None -> unowned.
    conv_owner = await resolve_owner("github", invoking_user) if invoking_user else None

    try:
        result = await create_conversation(
            message, repository=repo, git_provider="github", title=conv_title, on_created=_register,
            owner=conv_owner, source="github",
        )
        if not result:
            await _clear_pending(res_type, res_id)
            # The optimistic "on it" comment already posted in _register; correct it.
            await post_github_comment(
                owner=owner, repo=repo_name, issue_number=issue_number,
                body="…actually, Scooter couldn't start on this one — failed to create the conversation.",
            )
            return

        if result.get("interrupted"):
            # Run cut short by an agent-host restart; the conversation exists and is
            # resumed on boot. Don't post a failure and don't flush pending here.
            return

        if result.get("errored"):
            # The agent crashed mid-run; the conversation exists + did work. Post a
            # truthful "hit an error partway through" note, not "couldn't start".
            await _clear_pending(res_type, res_id)
            conv_id = result.get("conversation_id", "")
            await post_github_comment(
                owner=owner, repo=repo_name, issue_number=issue_number,
                body=f"Scooter hit an error partway through — see the [conversation]({conversation_url(conv_id)}) for details.",
            )
            return

        conv_id = result.get("conversation_id", "")

        # Flush pending messages
        messages = await db.get_and_clear_pending_messages("github", res_type, res_id)
        for msg in messages:
            ok = await send_message(conv_id, msg, source="github")
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
