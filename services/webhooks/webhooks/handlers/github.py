"""GitHub webhook handler.

Trigger rules:
- @openhands mention in issue/PR comment -> creates/forwards conversation
- 'openhands' label added to issue/PR -> creates conversation
- Any comment on resource with active conversation -> auto-forwarded
"""

import asyncio
import hashlib
import hmac
import logging

from fastapi import APIRouter, Header, HTTPException, Request

from .. import store as db
from ..store import PENDING_CONVERSATION_ID, is_pending

from ..config import settings
from ..agent_host_client import (
    conversation_url,
    create_conversation,
    find_conversations_by_url,
    get_conversation_status,
    push_link,
    send_message,
)
from ..identity_resolve import resolve_owner
from ..responses.github import post_github_comment

logger = logging.getLogger(__name__)
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

    logger.info("Received GitHub event: %s", event_type)

    if event_type == "issue_comment":
        await _handle_comment(payload)
    elif event_type == "issues":
        await _handle_issue_event(payload)
    elif event_type == "pull_request":
        await _handle_pr_event(payload)
    elif event_type == "check_suite":
        await _handle_check_suite(payload)
    elif event_type == "check_run":
        await _handle_check_run(payload)
    else:
        logger.debug("Ignoring GitHub event type: %s", event_type)

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

    existing = (
        await db.lookup_conversation("github", res_type, res_id)
        or await db.get_conversation_for_resource("github", res_type, res_id)
    )

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
        logger.warning("Failed to send to existing conversation %s, creating new one", existing)

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
                logger.warning("Failed to flush pending message to conversation %s", conv_id)
    except Exception:
        await _clear_pending(res_type, res_id)
        logger.exception("Error in background conversation creation for %s", res_id)


async def _clear_pending(res_type: str, res_id: str) -> None:
    existing = await db.lookup_conversation("github", res_type, res_id)
    if is_pending(existing):
        await db.clear_conversation("github", res_type, res_id)
    await db.get_and_clear_pending_messages("github", res_type, res_id)


# Agent app identities for loop prevention
AGENT_APP_IDENTITIES = ["app/scooter", "scooter[bot]"]


def _is_agent_event(actor: str) -> bool:
    """Check if an event was authored by the agent's own GitHub App.
    
    Loop prevention: the agent pushes -> CI runs -> agent is notified -> agent pushes -> loop.
    Ignore events from the agent's own app identity to break the loop.
    """
    actor_lower = actor.lower()
    return any(identity.lower() in actor_lower for identity in AGENT_APP_IDENTITIES)


async def _handle_check_suite(payload: dict):
    """Handle check_suite event (CI completed).
    
    Routes CI results back to conversations that own the linked PR.
    Notifies on failure (always) and success (only if conversation is awake).
    """
    action = payload.get("action", "")
    if action != "completed":
        return  # Only notify on completion, not queued/in_progress

    check_suite = payload.get("check_suite", {})
    conclusion = check_suite.get("conclusion", "")  # success, failure, cancelled, etc.
    head_sha = check_suite.get("head_sha", "")
    
    # Loop prevention: ignore events from the agent's own app
    app_info = check_suite.get("app", {})
    app_slug = app_info.get("slug", "")
    if app_slug and _is_agent_event(app_slug):
        logger.debug("Ignoring check_suite from agent app: %s", app_slug)
        return

    # Find the PR(s) this check suite is for
    pull_requests = check_suite.get("pull_requests", [])
    if not pull_requests:
        return  # No PR associated, nothing to route

    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")
    
    for pr_data in pull_requests:
        pr_number = pr_data.get("number")
        if not pr_number:
            continue
        
        pr_url = f"https://github.com/{owner}/{repo}/pull/{pr_number}"
        
        # Find all conversations that link to this PR
        conversation_ids = await find_conversations_by_url(pr_url)
        
        if not conversation_ids:
            logger.debug("No conversations found for PR %s", pr_url)
            continue
        
        # Decide whether to notify based on conclusion and conversation status
        should_notify_all = conclusion in ["failure", "cancelled", "timed_out", "action_required"]
        
        for conv_id in conversation_ids:
            # For success, only notify if conversation is awake (Q1)
            if conclusion == "success":
                status = await get_conversation_status(conv_id)
                if status != "running":
                    logger.debug("Skipping success notification for suspended conversation %s", conv_id)
                    continue
            elif not should_notify_all:
                # Skip other conclusions (neutral, skipped, stale)
                continue
            
            # Build the notification message
            check_suite_url = check_suite.get("html_url", "")
            head_branch = check_suite.get("head_branch", "unknown")
            
            if conclusion == "success":
                message = (
                    f"✅ **CI passed on PR #{pr_number}** (branch: {head_branch})\n\n"
                    f"All checks completed successfully.\n"
                    f"View details: {check_suite_url}"
                )
            else:
                message = (
                    f"❌ **CI failed on PR #{pr_number}** (branch: {head_branch})\n\n"
                    f"Check suite conclusion: `{conclusion}`\n"
                    f"Commit: `{head_sha[:7]}`\n\n"
                    f"**Next steps:**\n"
                    f"1. View the failed checks: {check_suite_url}\n"
                    f"2. Fix the issues\n"
                    f"3. Push your changes\n"
                    f"4. Confirm the checks pass"
                )
            
            # Send as a system message (source="webhook")
            ok = await send_message(conv_id, message, source="webhook")
            if ok:
                logger.info("Notified conversation %s of check_suite %s for PR #%s",
                          conv_id, conclusion, pr_number)
            else:
                logger.warning("Failed to notify conversation %s of check_suite for PR #%s",
                             conv_id, pr_number)


async def _handle_check_run(payload: dict):
    """Handle check_run event (individual CI check completed).
    
    Similar to check_suite, but for individual check runs within a suite.
    """
    action = payload.get("action", "")
    if action != "completed":
        return  # Only notify on completion

    check_run = payload.get("check_run", {})
    conclusion = check_run.get("conclusion", "")  # success, failure, etc.
    name = check_run.get("name", "")
    details_url = check_run.get("details_url", "")
    
    # Loop prevention: ignore events from the agent's own app
    app_info = check_run.get("app", {})
    app_slug = app_info.get("slug", "")
    if app_slug and _is_agent_event(app_slug):
        logger.debug("Ignoring check_run from agent app: %s", app_slug)
        return

    # Find the PR(s) this check run is for
    pull_requests = check_run.get("pull_requests", [])
    if not pull_requests:
        return  # No PR associated

    repo_data = payload.get("repository", {})
    owner = repo_data.get("owner", {}).get("login", "")
    repo = repo_data.get("name", "")
    
    for pr_data in pull_requests:
        pr_number = pr_data.get("number")
        if not pr_number:
            continue
        
        pr_url = f"https://github.com/{owner}/{repo}/pull/{pr_number}"
        
        # Find all conversations that link to this PR
        conversation_ids = await find_conversations_by_url(pr_url)
        
        if not conversation_ids:
            continue
        
        # Only notify on failures (individual check runs can be noisy on success)
        if conclusion not in ["failure", "cancelled", "timed_out", "action_required"]:
            continue
        
        for conv_id in conversation_ids:
            message = (
                f"❌ **Check failed on PR #{pr_number}**: `{name}`\n\n"
                f"Conclusion: `{conclusion}`\n"
                f"View details: {details_url}\n\n"
                f"Fix the issue and push your changes."
            )
            
            ok = await send_message(conv_id, message, source="webhook")
            if ok:
                logger.info("Notified conversation %s of check_run failure '%s' for PR #%s",
                          conv_id, name, pr_number)
            else:
                logger.warning("Failed to notify conversation %s of check_run for PR #%s",
                             conv_id, pr_number)
