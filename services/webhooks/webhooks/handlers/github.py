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
from ..agent_host_client import conversation_url, create_conversation, send_message
from ..responses.github import post_github_comment, update_github_comment
from .. import status_monitor

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
    return body.startswith("OpenHands is working on this.") or "OpenHands status:" in body


def _resource_id(owner: str, repo: str, number: int) -> str:
    return f"{owner}/{repo}#{number}"


def _response_instructions(owner: str, repo: str, number: int, is_pr: bool) -> str:
    kind = "PR" if is_pr else "issue"
    return (
        f"\n\n---\n"
        f"**Response workflow:** First, post an acknowledgment on GitHub so the requester knows you've seen it. "
        f"Then work on the task. When finished, post a follow-up comment with your results.\n\n"
        f"To respond on GitHub {kind} #{number}, use: "
        f"`gh issue comment {number} -R {owner}/{repo} -b \"your response\"`"
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
        f"To respond, use: `gh issue comment {number} -R {owner}/{repo} -b \"your response\"`"
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
        ok = await send_message(existing, forward_msg)
        if ok:
            return
        logger.warning("Failed to send to existing conversation %s, creating new one", existing)

    # Post status comment
    note_id = await post_github_comment(
        owner=owner, repo=repo, issue_number=issue_number,
        body=":hourglass_flowing_sand: OpenHands status: **CREATING**",
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
            note_id=note_id,
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

    note_id = await post_github_comment(
        owner=owner, repo=repo, issue_number=issue_number,
        body=":hourglass_flowing_sand: OpenHands status: **CREATING**",
    )

    reply_hint = _response_instructions(owner, repo, issue_number, is_pr=False)
    message = f"Issue #{issue_number} '{issue_title}' in {full_repo}\n\n{issue_body}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            res_type="issue", res_id=res_id,
            message=message, repo=full_repo,
            conv_title=f"Issue #{issue_number}: {issue_title}",
            owner=owner, repo_name=repo, issue_number=issue_number,
            note_id=note_id,
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

    note_id = await post_github_comment(
        owner=owner, repo=repo, issue_number=pr_number,
        body=":hourglass_flowing_sand: OpenHands status: **CREATING**",
    )

    reply_hint = _response_instructions(owner, repo, pr_number, is_pr=True)
    message = f"PR #{pr_number} '{pr_title}' (branch: {source_branch}) in {full_repo}\n\n{pr_body}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            res_type="pull_request", res_id=res_id,
            message=message, repo=full_repo,
            conv_title=f"PR #{pr_number}: {pr_title}",
            owner=owner, repo_name=repo, issue_number=pr_number,
            note_id=note_id,
        )
    )


async def _background_create_conversation(
    res_type: str, res_id: str, message: str, repo: str,
    conv_title: str, owner: str, repo_name: str,
    issue_number: int, note_id: int | None,
) -> None:
    try:
        result = await create_conversation(message, repository=repo, git_provider="github", title=conv_title)
        if not result:
            await _clear_pending(res_type, res_id)
            if note_id:
                await update_github_comment(
                    owner=owner, repo=repo_name, comment_id=note_id,
                    body=":x: OpenHands status: **ERROR**\n\nFailed to create conversation.",
                )
            return

        conv_id = result.get("conversation_id", "")
        await db.store_conversation("github", res_type, res_id, conv_id)
        conv_link = conversation_url(conv_id)

        # Flush pending messages
        messages = await db.get_and_clear_pending_messages("github", res_type, res_id)
        for msg in messages:
            ok = await send_message(conv_id, msg)
            if not ok:
                logger.warning("Failed to flush pending message to conversation %s", conv_id)

        if note_id:
            await update_github_comment(
                owner=owner, repo=repo_name, comment_id=note_id,
                body=f":hourglass_flowing_sand: OpenHands status: **RUNNING**\n\n[View conversation]({conv_link})",
            )
            status_monitor.track_github(
                conversation_id=conv_id, owner=owner, repo=repo_name,
                issue_number=issue_number, comment_id=note_id,
            )
    except Exception:
        await _clear_pending(res_type, res_id)
        logger.exception("Error in background conversation creation for %s", res_id)


async def _clear_pending(res_type: str, res_id: str) -> None:
    existing = await db.lookup_conversation("github", res_type, res_id)
    if is_pending(existing):
        await db.clear_conversation("github", res_type, res_id)
    await db.get_and_clear_pending_messages("github", res_type, res_id)
