"""Jira webhook handler.

Trigger rules:
- @openhands mention in issue comment -> creates/forwards conversation
- 'openhands' label added to issue -> creates conversation
- Any comment on issue with active conversation -> auto-forwarded

Note: Jira relay endpoints (API proxy for agents) have moved to the broker service.
"""

import asyncio
import logging

from fastapi import APIRouter, Request

from .. import store as db
from ..store import PENDING_CONVERSATION_ID, is_pending

from ..config import settings
from ..agent_host_client import conversation_url, create_conversation, send_message
from ..responses.jira import post_jira_comment

logger = logging.getLogger(__name__)
router = APIRouter()


def _contains_mention(text: str) -> bool:
    return settings.mention_pattern.lower() in text.lower()


def _is_own_comment(body: str, author_account_id: str) -> bool:
    if settings.jira_bot_account_id and author_account_id == settings.jira_bot_account_id:
        return True
    # Recognize Scooter's own comments; keep matching the legacy "OpenHands"
    # marker so in-flight tickets created before the rename still match.
    return body.startswith("Scooter is on it") or "OpenHands status:" in body


def _is_ignored_user(username: str) -> bool:
    if not settings.ignore_usernames:
        return False
    ignored = {u.strip().lower() for u in settings.ignore_usernames.split(",")}
    return username.lower() in ignored


def _format_forwarded_message(
    comment_body: str, issue_key: str, has_mention: bool,
) -> str:
    if has_mention:
        preamble = (
            f"You were mentioned in a comment on Jira issue {issue_key}. "
            f"First, post an acknowledgment so the requester knows you've seen it. "
            f"Then work on the task. When finished, post a follow-up comment with your results."
        )
    else:
        preamble = (
            f"A new comment was posted on Jira issue {issue_key}. "
            f"This is for your awareness -- no action is required unless the comment explicitly asks you to do something."
        )

    reply_instruction = (
        "To respond, use the `jira_comment` tool (this issue is already known — you just "
        "provide the comment body). It reports the real result."
    )

    return f"{preamble}\n\n---\n\n{comment_body}\n\n---\n\n{reply_instruction}"


def _response_instructions(issue_key: str) -> str:
    return (
        f"\n\n---\n"
        f"**Response workflow:** First, acknowledge so the requester knows you've seen it. "
        f"Then work on the task. When finished, post a follow-up comment with your results.\n\n"
        f"To respond on Jira, use the `jira_comment` tool (issue {issue_key} is already known — "
        f"you just provide the body)."
    )


@router.post("/webhooks/jira")
async def handle_jira_webhook(request: Request):
    """Receive Jira webhook events (comment_created, issue_updated, etc.)."""
    if not settings.jira_enabled:
        return {"status": "disabled"}

    payload = await request.json()
    event_type = payload.get("webhookEvent", "")

    logger.info("Received Jira event: %s", event_type)

    if event_type == "comment_created":
        await _handle_comment(payload)
    elif event_type == "comment_updated":
        await _handle_comment(payload)
    elif event_type == "jira:issue_updated":
        await _handle_issue_updated(payload)
    else:
        logger.debug("Ignoring Jira event type: %s", event_type)

    return {"status": "ok"}


async def _handle_comment(payload: dict):
    """Handle comment_created and comment_updated events."""
    comment = payload.get("comment", {})
    comment_body = comment.get("body", "")
    author = comment.get("author", {})
    author_name = author.get("displayName", "unknown")
    author_account_id = author.get("accountId", "")

    issue = payload.get("issue", {})
    issue_key = issue.get("key", "")
    issue_summary = issue.get("fields", {}).get("summary", "")

    if _is_own_comment(comment_body, author_account_id):
        return
    if _is_ignored_user(author_name):
        return

    has_mention = _contains_mention(comment_body)

    existing = (
        await db.lookup_conversation("jira", "issue", issue_key)
        or await db.get_conversation_for_jira_ticket(issue_key)
        or await db.get_conversation_for_resource("jira", "issue", issue_key)
    )

    if not has_mention and not existing:
        return

    message_text = comment_body.replace(settings.mention_pattern, "").strip()
    comment_text = f"@{author_name} commented:\n\n{message_text}"

    if is_pending(existing):
        forward_msg = _format_forwarded_message(comment_text, issue_key, has_mention)
        await db.store_pending_message("jira", "issue", issue_key, forward_msg)
        return

    if existing:
        forward_msg = _format_forwarded_message(comment_text, issue_key, has_mention)
        ok = await send_message(existing, forward_msg, priority=has_mention)
        if ok:
            return
        logger.warning("Failed to send to existing conversation %s, creating new one", existing)

    await db.store_conversation("jira", "issue", issue_key, PENDING_CONVERSATION_ID)
    await db.link_jira_ticket(PENDING_CONVERSATION_ID, issue_key)

    conv_title = f"Jira {issue_key}: {issue_summary}"
    reply_hint = _response_instructions(issue_key)
    context = f"Context: Jira issue {issue_key} '{issue_summary}'"
    full_message = f"{context}\n\n{comment_text}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            issue_key=issue_key, message=full_message,
            conv_title=conv_title,
        )
    )


async def _handle_issue_updated(payload: dict):
    """Handle issue_updated event — check for 'openhands' label addition."""
    changelog = payload.get("changelog", {})
    items = changelog.get("items", [])

    label_added = False
    for item in items:
        if item.get("field") == "labels" and "openhands" in (item.get("toString", "") or "").lower():
            label_added = True
            break

    if not label_added:
        return

    issue = payload.get("issue", {})
    issue_key = issue.get("key", "")
    issue_summary = issue.get("fields", {}).get("summary", "")
    issue_desc = issue.get("fields", {}).get("description", "") or ""

    existing = (
        await db.lookup_conversation("jira", "issue", issue_key)
        or await db.get_conversation_for_jira_ticket(issue_key)
    )
    if existing:
        return

    await db.store_conversation("jira", "issue", issue_key, PENDING_CONVERSATION_ID)
    await db.link_jira_ticket(PENDING_CONVERSATION_ID, issue_key)

    reply_hint = _response_instructions(issue_key)
    message = f"Jira issue {issue_key} '{issue_summary}'\n\n{issue_desc}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            issue_key=issue_key, message=message,
            conv_title=f"Jira {issue_key}: {issue_summary}",
        )
    )


async def _background_create_conversation(
    issue_key: str, message: str, conv_title: str,
) -> None:
    # Register the mapping + link AND post the "on it — follow along" comment
    # BEFORE the agent runs. create_conversation blocks until the whole turn
    # finishes, so posting the link comment after it returned delayed it by the
    # entire run (the 5-10min lag). Only conv_id is needed, known in the hook.
    async def _register(conv_id: str) -> None:
        await db.store_conversation("jira", "issue", issue_key, conv_id)
        await db.link_jira_ticket(conv_id, issue_key)
        await post_jira_comment(
            issue_key=issue_key,
            body=f"Scooter is on it — follow along: {conversation_url(conv_id)}",
        )

    try:
        result = await create_conversation(message, title=conv_title, on_created=_register)
        if not result:
            await _clear_pending(issue_key)
            # The optimistic "on it" comment already posted in _register; correct it.
            await post_jira_comment(
                issue_key=issue_key,
                body="…actually, Scooter couldn't start on this one — failed to create the conversation.",
            )
            return

        if result.get("interrupted"):
            # Run cut short by an agent-host restart; the conversation exists and is
            # resumed on boot. Don't post a failure and don't flush pending here.
            return

        conv_id = result.get("conversation_id", "")

        # Flush pending messages
        messages = await db.get_and_clear_pending_messages("jira", "issue", issue_key)
        for msg in messages:
            ok = await send_message(conv_id, msg)
            if not ok:
                logger.warning("Failed to flush pending message to conversation %s", conv_id)
    except Exception:
        await _clear_pending(issue_key)
        logger.exception("Error in background conversation creation for Jira %s", issue_key)


async def _clear_pending(issue_key: str) -> None:
    existing = await db.lookup_conversation("jira", "issue", issue_key)
    if is_pending(existing):
        await db.clear_conversation("jira", "issue", issue_key)
    await db.get_and_clear_pending_messages("jira", "issue", issue_key)
