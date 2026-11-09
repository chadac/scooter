"""Jira webhook handler.

A mention in an issue comment creates or forwards a conversation, the trigger label
creates one, and any comment on an issue with an active conversation is
auto-forwarded.
"""

import hashlib
import hmac
import json
import logging

from fastapi import APIRouter, Header, HTTPException, Request

from scooter_webhooks_lib import store as db
from scooter_webhooks_lib.store import PENDING_CONVERSATION_ID, is_pending

from .config import settings
from scooter_webhooks_lib import policy
from scooter_webhooks_lib.agent_host_client import (
    SendOutcome, conversation_url, create_conversation, deliver_message, push_link, send_message,
)
from .responses import post_jira_comment
from .senders import sender_of
from scooter_webhooks_lib.sender import Sender
from scooter_webhooks_lib.tasks import spawn

logger = logging.getLogger(__name__)
_C = {"component": "handlers.jira"}
router = APIRouter()

# WebSub `method=signature`; Jira sends sha256 today but the method is part of the header.
_SIGNATURE_METHODS = {"sha256": hashlib.sha256, "sha384": hashlib.sha384, "sha512": hashlib.sha512}


def _verify_signature(body: bytes, header: str) -> bool:
    """Whether `X-Hub-Signature` is a valid HMAC of the body; fails closed when no secret is configured."""
    if not settings.jira_webhook_secret:
        return False
    method, sep, signature = (header or "").partition("=")
    digest = _SIGNATURE_METHODS.get(method.strip().lower())
    if not sep or digest is None:
        return False
    expected = hmac.new(settings.jira_webhook_secret.encode(), body, digest).hexdigest()
    return hmac.compare_digest(expected, signature.strip().lower())


def _added_labels(item: dict) -> set[str]:
    """Labels a `labels` changelog item adds; Jira sends both sides as space-separated lists."""
    before = set((item.get("fromString") or "").split())
    return set((item.get("toString") or "").split()) - before


def _is_own_comment(body: str, author_account_id: str) -> bool:
    if settings.jira_bot_account_id and author_account_id == settings.jira_bot_account_id:
        return True
    # Our own comments, including the legacy "OpenHands" marker.
    return body.startswith("Scooter is on it") or "OpenHands status:" in body


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
async def handle_jira_webhook(
    request: Request,
    x_hub_signature: str = Header(default=""),
):
    """Receive Jira webhook events (comment_created, issue_updated, etc.)."""
    if not settings.jira_enabled:
        return {"status": "disabled"}

    body = await request.body()
    if not _verify_signature(body, x_hub_signature):
        raise HTTPException(status_code=401, detail="Invalid webhook signature")

    payload = json.loads(body)
    event_type = payload.get("webhookEvent", "")

    logger.info("received event", extra={**_C, "source": "jira", "event_type": event_type})
    spawn(_dispatch(event_type, payload), extra={"source": "jira", "event_type": event_type})
    return {"status": "ok"}


async def _dispatch(event_type: str, payload: dict) -> None:
    if event_type == "comment_created":
        await _handle_comment(payload)
    elif event_type == "comment_updated":
        await _handle_comment(payload)
    elif event_type == "jira:issue_updated":
        await _handle_issue_updated(payload)
    else:
        logger.debug("ignoring event type", extra={**_C, "source": "jira", "event_type": event_type})


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
    if policy.is_ignored_user(author_name):
        return

    has_mention = policy.mentions_agent(comment_body)

    existing = (
        await db.lookup_conversation("jira", "issue", issue_key)
        or await db.get_conversation_for_resource("jira", "issue", issue_key)
        or await db.get_conversation_for_resource("jira", "issue", issue_key)
    )

    if not has_mention and not existing:
        return
    sender = await sender_of(author, issue)

    message_text = policy.strip_mention(comment_body)
    comment_text = f"@{author_name} commented:\n\n{message_text}"

    if is_pending(existing):
        forward_msg = _format_forwarded_message(comment_text, issue_key, has_mention)
        await db.store_pending_message("jira", "issue", issue_key, forward_msg, sender)
        return

    if existing:
        forward_msg = _format_forwarded_message(comment_text, issue_key, has_mention)
        outcome = await deliver_message(existing, forward_msg, source="jira", sender=sender)
        if outcome is not SendOutcome.NOT_FOUND:
            # The conversation still exists, so a failed run keeps its mapping (issue #802).
            if outcome is not SendOutcome.DELIVERED:
                logger.warning(
                    "forward to existing conversation failed, keeping it",
                    extra={
                        **_C,
                        "conversation_id": existing,
                        "outcome": outcome.value,
                        "source": "jira",
                        "resource_type": "issue",
                        "resource_id": issue_key,
                    },
                )
            return
        logger.warning(
            "existing conversation no longer exists, creating a new one",
            extra={
                **_C,
                "conversation_id": existing,
                "source": "jira",
                "resource_type": "issue",
                "resource_id": issue_key,
            },
        )

    await db.store_conversation("jira", "issue", issue_key, PENDING_CONVERSATION_ID)
    await db.link_resource(PENDING_CONVERSATION_ID, "jira", "issue", issue_key)

    conv_title = f"Jira {issue_key}: {issue_summary}"
    reply_hint = _response_instructions(issue_key)
    context = f"Context: Jira issue {issue_key} '{issue_summary}'"
    full_message = f"{context}\n\n{comment_text}{reply_hint}"

    spawn(
        _background_create_conversation(
            issue_key=issue_key, message=full_message,
            conv_title=conv_title, sender=sender,
        )
    )


async def _handle_issue_updated(payload: dict):
    """Handle an issue_updated event that adds the trigger label."""
    changelog = payload.get("changelog", {})
    items = changelog.get("items", [])

    label_added = any(
        policy.is_trigger_label(label)
        for item in items if item.get("field") == "labels"
        for label in _added_labels(item)
    )

    if not label_added:
        return

    issue = payload.get("issue", {})
    issue_key = issue.get("key", "")
    issue_summary = issue.get("fields", {}).get("summary", "")
    issue_desc = issue.get("fields", {}).get("description", "") or ""

    existing = (
        await db.lookup_conversation("jira", "issue", issue_key)
        or await db.get_conversation_for_resource("jira", "issue", issue_key)
    )
    if existing:
        return

    await db.store_conversation("jira", "issue", issue_key, PENDING_CONVERSATION_ID)
    await db.link_resource(PENDING_CONVERSATION_ID, "jira", "issue", issue_key)

    reply_hint = _response_instructions(issue_key)
    message = f"Jira issue {issue_key} '{issue_summary}'\n\n{issue_desc}{reply_hint}"

    spawn(
        _background_create_conversation(
            issue_key=issue_key, message=message,
            conv_title=f"Jira {issue_key}: {issue_summary}",
            actor=payload.get("user"), issue=issue,
        )
    )


async def _background_create_conversation(
    issue_key: str, message: str, conv_title: str,
    sender: Sender | None = None, actor: dict | None = None, issue: dict | None = None,
) -> None:
    """Start a conversation for an issue; `actor` names the sender when `sender` isn't given."""
    # Runs pre-run, since create_conversation blocks until the whole agent turn finishes.
    async def _register(conv_id: str) -> None:
        await db.store_conversation("jira", "issue", issue_key, conv_id)
        await db.link_resource(conv_id, "jira", "issue", issue_key)
        # No url, since the site base is not configured here, so the ticket key is both the title and the ref.
        await push_link(
            conv_id, source="jira", resource_type="issue",
            title=issue_key, ref={"issueKey": issue_key},
        )
        await post_jira_comment(
            issue_key=issue_key,
            body=f"Scooter is on it — follow along: {conversation_url(conv_id)}",
        )

    try:
        if sender is None and actor is not None:
            # Looked up here, off the webhook's response path.
            sender = await sender_of(actor, issue or {})
        result = await create_conversation(message, title=conv_title, on_created=_register, source="jira", sender=sender)
        if not result:
            await _clear_pending(issue_key)
            # Correct the optimistic comment already posted in _register.
            await post_jira_comment(
                issue_key=issue_key,
                body="…actually, Scooter couldn't start on this one — failed to create the conversation.",
            )
            return

        if result.get("interrupted"):
            # The agent-host resumes the interrupted run on boot, so neither post a failure nor flush pending.
            return

        if result.get("errored"):
            # The conversation exists and did work, so this is an error partway through, not a failed start.
            await _clear_pending(issue_key)
            conv_id = result.get("conversation_id", "")
            await post_jira_comment(
                issue_key=issue_key,
                body=f"Scooter hit an error partway through — see the conversation for details: {conversation_url(conv_id)}",
            )
            return

        conv_id = result.get("conversation_id", "")

        messages = await db.get_and_clear_pending_messages("jira", "issue", issue_key)
        for msg, msg_sender in messages:
            ok = await send_message(conv_id, msg, source="jira", sender=msg_sender)
            if not ok:
                logger.warning(
                    "flush of pending message failed",
                    extra={**_C, "conversation_id": conv_id, "source": "jira", "resource_id": issue_key},
                )
    except Exception:
        await _clear_pending(issue_key)
        logger.exception(
            "background conversation creation failed",
            extra={**_C, "source": "jira", "resource_type": "issue", "resource_id": issue_key},
        )


async def _clear_pending(issue_key: str) -> None:
    existing = await db.lookup_conversation("jira", "issue", issue_key)
    if is_pending(existing):
        await db.clear_conversation("jira", "issue", issue_key)
    await db.get_and_clear_pending_messages("jira", "issue", issue_key)


# Discovered and mounted by the webhooks service via the entry-point registry; the handler self-gates in-route.
from scooter_webhooks_lib.registry import WebhookHandler, register_webhook


@register_webhook
def jira() -> WebhookHandler:
    return WebhookHandler(name="jira", router=router)
