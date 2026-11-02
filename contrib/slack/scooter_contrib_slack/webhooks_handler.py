"""Slack webhook handler.

A mention in a channel creates or forwards a conversation; any message in a thread
with an active conversation is auto-forwarded.
"""

import asyncio
import hashlib
import hmac
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from scooter_webhooks_lib import store as db
from scooter_webhooks_lib.store import PENDING_CONVERSATION_ID, is_pending

from .config import require_relay_key, settings
from scooter_webhooks_lib.agent_host_client import conversation_url, create_conversation, push_link, send_message
from scooter_webhooks_lib import policy
from scooter_webhooks_lib.identity import resolve_owner
from .files import DownloadedFiles, download_files
from .senders import sender_of
from scooter_webhooks_lib.sender import Sender
from .responses import (
    add_slack_reaction,
    get_bot_user_id,
    get_thread_history,
    post_slack_message,
    reply_in_thread,
)

logger = logging.getLogger(__name__)
_C = {"component": "handlers.slack"}
router = APIRouter()

_bot_user_id: str | None = None

# Bounded in-process guard against Slack's retried deliveries, keyed on the stable `event_id`; the webhooks service runs a single replica.
from collections import OrderedDict

_SEEN_EVENT_IDS: "OrderedDict[str, None]" = OrderedDict()
_SEEN_EVENT_IDS_MAX = 4096

# Messages already dispatched to the agent, keyed on channel:ts, because one mention arrives as both an `app_mention` and a `message` event with different event_ids; both handlers record here only at the point of dispatch.
_DISPATCHED_MESSAGES: "OrderedDict[str, None]" = OrderedDict()
_DISPATCHED_MESSAGES_MAX = 4096


def _already_handled(event_id: str) -> bool:
    """True if this Slack event_id was seen before."""
    if not event_id:
        return False
    if event_id in _SEEN_EVENT_IDS:
        return True
    _SEEN_EVENT_IDS[event_id] = None
    while len(_SEEN_EVENT_IDS) > _SEEN_EVENT_IDS_MAX:
        _SEEN_EVENT_IDS.popitem(last=False)
    return False


def _message_already_dispatched(channel: str, ts: str) -> bool:
    """True if this message (channel:ts) was already dispatched by either handler; read-only."""
    if not ts:
        return False
    return f"{channel}:{ts}" in _DISPATCHED_MESSAGES


def _record_message_dispatched(channel: str, ts: str) -> None:
    """Mark a message (channel:ts) as dispatched, only at the point a handler actually forwards or creates."""
    if not ts:
        return
    _DISPATCHED_MESSAGES[f"{channel}:{ts}"] = None
    while len(_DISPATCHED_MESSAGES) > _DISPATCHED_MESSAGES_MAX:
        _DISPATCHED_MESSAGES.popitem(last=False)


def _verify_slack_signature(body: bytes, timestamp: str, signature: str) -> bool:
    # Fail closed: an unset secret must not admit forged events.
    if not settings.slack_signing_secret:
        logger.warning("SLACK_SIGNING_SECRET is not set; rejecting the unverifiable delivery", extra=_C)
        return False
    if abs(time.time() - int(timestamp)) > 60 * 5:
        return False
    sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
    expected = "v0=" + hmac.new(
        settings.slack_signing_secret.encode(),
        sig_basestring.encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def _resource_id(channel: str, thread_ts: str) -> str:
    return f"{channel}:{thread_ts}"


def _weave_attachments(text: str, dl: DownloadedFiles) -> str:
    """Append the inlined text attachments to the message; binary files and images ride as content parts instead."""
    if not dl.inline_text:
        return text
    return text + "\n\n" + dl.inline_text


def _format_forwarded_message(
    comment_body: str, channel: str, thread_ts: str, has_mention: bool,
) -> str:
    if has_mention:
        preamble = (
            f"You were mentioned in a Slack message in channel {channel}. "
            f"First, post an acknowledgment via the broker so the requester knows you've seen it. "
            f"Then work on the task. When finished, post a follow-up message with your results."
        )
    else:
        preamble = (
            f"A new message was posted in a Slack thread in channel {channel}. "
            f"This is for your awareness -- no action is required unless the message explicitly asks you to do something."
        )

    reply_hint = (
        f"\n\n---\n"
        f"To reply, use the `slack_respond` tool (this thread is already known — you just "
        f"provide the text). To react with an emoji, use `slack_react` and pass the "
        f"`message_ts` shown above (it reacts to that specific message)."
    )
    return f"{preamble}\n\n---\n\n{comment_body}{reply_hint}"


def _response_instructions() -> str:
    return (
        f"\n\n---\n"
        f"**Response workflow:** First, post an acknowledgment in the Slack thread so the requester knows you've seen it. "
        f"Then work on the task. When finished, post a follow-up message with your results.\n\n"
        f"To respond, use your Slack reply tool (the one described as 'Respond in the Slack thread') — it already knows "
        f"this thread, so you only supply the message text. If you're unsure which tool that is, re-check your tool list "
        f"and use the one for Slack.\n\n"
        f"Do NOT post to Slack with raw curl / the broker `chat.postMessage` endpoint: a hand-built call omits the "
        f"thread and lands in the ROOT CHANNEL (visible to everyone) instead of this thread. Always use the tool."
    )


@router.post("/webhooks/slack")
async def handle_slack_event(request: Request):
    """Receive Slack Events API callbacks (app_mention, message)."""
    if not settings.slack_enabled:
        return {"status": "disabled"}

    body = await request.body()
    payload = await request.json()

    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge", "")}

    timestamp = request.headers.get("x-slack-request-timestamp", "")
    signature = request.headers.get("x-slack-signature", "")
    if not _verify_slack_signature(body, timestamp, signature):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    event_type = payload.get("type", "")

    if event_type == "event_callback":
        event_id = payload.get("event_id", "")
        if _already_handled(event_id):
            retry = request.headers.get("x-slack-retry-num", "")
            logger.info(
                "event already handled, dropping duplicate",
                extra={**_C, "source": "slack", "event_id": event_id, "retry_num": retry or None},
            )
            return {"status": "ok", "deduped": True}
        event = payload.get("event", {})
        await _handle_event(event, workspace=payload.get("team_id", ""))

    return {"status": "ok"}


async def _get_bot_id() -> str | None:
    global _bot_user_id
    if _bot_user_id is None:
        _bot_user_id = await get_bot_user_id()
    return _bot_user_id


async def _handle_event(event: dict, workspace: str = ""):
    """Route one event; `workspace` is the team the app received it in."""
    event_type = event.get("type", "")
    subtype = event.get("subtype", "")

    if subtype in ("bot_message", "message_changed", "message_deleted"):
        return

    bot_id = await _get_bot_id()
    user = event.get("user", "")
    if bot_id and user == bot_id:
        return

    if event_type == "app_mention":
        await _handle_mention(event, workspace)
    elif event_type == "message":
        await _handle_thread_message(event, workspace)


async def _format_thread_history(channel: str, thread_ts: str, up_to_ts: str) -> str:
    """Format the thread's messages before `up_to_ts` as context for a mention inside an existing thread, or "" when there is none or the fetch fails."""
    try:
        messages = await get_thread_history(channel, thread_ts)
    except Exception:
        logger.exception(
            "thread history fetch failed",
            extra={**_C, "source": "slack", "channel": channel, "thread_ts": thread_ts},
        )
        return ""
    bot_id = await _get_bot_id()
    lines: list[str] = []
    for m in messages:
        m_ts = m.get("ts", "")
        # Skip the mention itself and our own bot posts.
        if m_ts and up_to_ts and m_ts >= up_to_ts:
            continue
        if bot_id and m.get("user") == bot_id:
            continue
        author = m.get("user", "unknown")
        body = (m.get("text") or "").strip()
        if body:
            lines.append(f"<@{author}>: {body}")
    if not lines:
        return ""
    joined = "\n".join(lines)
    return (
        "This thread already has a conversation. Here is its history "
        f"(oldest first), for context:\n\n{joined}\n"
    )


async def _handle_mention(event: dict, workspace: str = ""):
    """Handle app_mention events."""
    text = event.get("text", "")
    user = event.get("user", "unknown")
    channel = event.get("channel", "")
    ts = event.get("ts", "")
    thread_ts = event.get("thread_ts", ts)

    if policy.is_ignored_user(user):
        return

    # Keyed on the message `ts` the twin events share, not thread_ts.
    if _message_already_dispatched(channel, ts):
        logger.info(
            "message already dispatched, dropping the twin",
            extra={**_C, "source": "slack", "channel": channel, "message_ts": ts, "event": "app_mention"},
        )
        return

    res_id = _resource_id(channel, thread_ts)

    existing = (
        await db.lookup_conversation("slack", "thread", res_id)
        or await db.get_conversation_for_resource("slack", "thread", res_id)
    )

    # Rewrite the bot's own <@U…> mention to the plain pattern and leave other user mentions intact.
    import re
    bot_id = await _get_bot_id()
    message_text = text.strip()
    if bot_id:
        message_text = re.sub(rf"<@{re.escape(bot_id)}>", policy.mention_pattern(), message_text)
    message_text = message_text.strip()

    comment_text = f"<@{user}> said:\n\n{message_text}\n\n(message_ts: {ts} — pass this to slack_react to react to THIS message)"

    # Images ride as content parts, text files are inlined, binary files become file parts the agent-host writes to the sandbox.
    dl = await download_files(event.get("files"))
    images = dl.images
    files = dl.file_parts
    comment_text = _weave_attachments(comment_text, dl)
    sender = await sender_of(event, workspace)

    if is_pending(existing):
        _record_message_dispatched(channel, ts)
        forward_msg = _format_forwarded_message(comment_text, channel, thread_ts, has_mention=True)
        await db.store_pending_message("slack", "thread", res_id, forward_msg, sender)
        return

    if existing:
        # Forward off the request path, since send_message blocks for the whole agent turn and Slack retries after ~3s.
        _record_message_dispatched(channel, ts)
        forward_msg = _format_forwarded_message(comment_text, channel, thread_ts, has_mention=True)
        await add_slack_reaction(channel, ts, "eyes")
        # A mention to an active conversation is priority, so the agent-host may interrupt a stuck turn.
        asyncio.create_task(
            _background_forward(existing, forward_msg, priority=True, images=images, files=files, sender=sender)
        )
        return

    _record_message_dispatched(channel, ts)
    await add_slack_reaction(channel, ts, "eyes")

    await db.store_conversation("slack", "thread", res_id, PENDING_CONVERSATION_ID)

    # A mention inside an existing thread carries the thread's prior history as context.
    history = ""
    if thread_ts and thread_ts != ts:
        history = await _format_thread_history(channel, thread_ts, up_to_ts=ts)

    reply_hint = _response_instructions()
    prefix = f"{history}\n---\n\n" if history else ""
    full_message = f"{prefix}Slack message in channel {channel}:\n\n{comment_text}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            res_id=res_id, message=full_message,
            conv_title=f"Slack: {message_text[:50]}",
            channel=channel, thread_ts=thread_ts, invoking_user=user, images=images, files=files,
            sender=sender,
        )
    )


async def _handle_thread_message(event: dict, workspace: str = ""):
    """Handle message events in threads with active conversations."""
    thread_ts = event.get("thread_ts")
    if not thread_ts:
        return

    text = event.get("text", "")
    user = event.get("user", "unknown")
    channel = event.get("channel", "")

    if policy.is_ignored_user(user):
        return

    bot_id = await _get_bot_id()
    if bot_id and user == bot_id:
        return

    ts = event.get("ts", "")

    # A message that mentions the bot also arrives as an `app_mention` event, which _handle_mention owns.
    if policy.mentions_agent(text) or (bot_id and f"<@{bot_id}>" in text):
        return

    # Text-independent backstop for a twin whose mention text Slack stripped or rewrote.
    if _message_already_dispatched(channel, ts):
        logger.info(
            "message already dispatched, dropping the twin",
            extra={**_C, "source": "slack", "channel": channel, "message_ts": ts, "event": "message"},
        )
        return

    res_id = _resource_id(channel, thread_ts)

    existing = (
        await db.lookup_conversation("slack", "thread", res_id)
        or await db.get_conversation_for_resource("slack", "thread", res_id)
    )

    if not existing:
        return

    comment_text = f"<@{user}> said:\n\n{text}\n\n(message_ts: {ts} — pass this to slack_react to react to THIS message)"

    dl = await download_files(event.get("files"))
    comment_text = _weave_attachments(comment_text, dl)
    sender = await sender_of(event, workspace)

    if is_pending(existing):
        _record_message_dispatched(channel, ts)
        forward_msg = _format_forwarded_message(comment_text, channel, thread_ts, has_mention=False)
        await db.store_pending_message("slack", "thread", res_id, forward_msg, sender)
        return

    # Forward off the request path, since send_message blocks for the whole agent turn.
    _record_message_dispatched(channel, ts)
    forward_msg = _format_forwarded_message(comment_text, channel, thread_ts, has_mention=False)
    asyncio.create_task(
        # Unmentioned replies interrupt too: queued until the run ends, they arrive out of order with the thread.
        _background_forward(existing, forward_msg, priority=True, images=dl.images, files=dl.file_parts, sender=sender)
    )


async def _background_forward(
    existing: str,
    forward_msg: str,
    *,
    priority: bool,
    images: list[dict] | None = None,
    files: list[dict] | None = None,
    sender: Sender | None = None,
) -> None:
    """Forward a follow-up into an existing conversation off the request path."""
    ok = await send_message(existing, forward_msg, priority=priority, images=images, files=files, source="slack", sender=sender)
    if not ok:
        logger.warning(
            "forward message to conversation failed",
            extra={**_C, "conversation_id": existing, "source": "slack", "priority": priority},
        )


async def _background_create_conversation(
    res_id: str, message: str, conv_title: str,
    channel: str, thread_ts: str, invoking_user: str | None = None,
    images: list[dict] | None = None,
    files: list[dict] | None = None,
    sender: Sender | None = None,
) -> None:
    # The thread anchor is registered pre-run so the agent's first slack_respond has a thread to infer.
    async def _register(conv_id: str) -> None:
        await db.store_conversation("slack", "thread", res_id, conv_id)
        # The DB fallback resolves the thread even if the link push is slow or lost.
        await db.store_slack_metadata(conv_id, channel, thread_ts)
        await push_link(
            conv_id, source="slack", resource_type="thread",
            title=f"{channel} thread",
            ref={"channel": channel, "threadTs": thread_ts},
        )
        # Posted pre-run, since create_conversation blocks until the whole agent turn finishes.
        await post_slack_message(
            channel=channel,
            text=f"Scooter is on it — follow along: <{conversation_url(conv_id)}|View conversation>",
            thread_ts=thread_ts,
        )

    # Best-effort owner lookup; None leaves the conversation unowned.
    owner = await resolve_owner("slack", invoking_user) if invoking_user else None

    try:
        result = await create_conversation(message, title=conv_title, on_created=_register, owner=owner, images=images, files=files, source="slack", sender=sender)
        if not result:
            await _clear_pending(res_id)
            # Correct the optimistic ack already posted in _register.
            await post_slack_message(
                channel=channel,
                text="…actually, Scooter couldn't start on this one — failed to create the conversation.",
                thread_ts=thread_ts,
            )
            return

        if result.get("interrupted"):
            # The agent-host resumes the interrupted run on boot, so neither post a failure nor flush pending.
            return

        if result.get("errored"):
            # The conversation exists and did work, so this is an error partway through, not a failed start.
            await _clear_pending(res_id)
            conv_id = result.get("conversation_id", "")
            await post_slack_message(
                channel=channel,
                text=f"Scooter hit an error partway through — see the conversation for details: <{conversation_url(conv_id)}|View conversation>",
                thread_ts=thread_ts,
            )
            return

        conv_id = result.get("conversation_id", "")

        messages = await db.get_and_clear_pending_messages("slack", "thread", res_id)
        for msg, msg_sender in messages:
            ok = await send_message(conv_id, msg, source="slack", sender=msg_sender)
            if not ok:
                logger.warning(
                    "flush of pending message failed",
                    extra={**_C, "conversation_id": conv_id, "source": "slack", "resource_id": res_id},
                )
    except Exception:
        await _clear_pending(res_id)
        logger.exception(
            "background conversation creation failed",
            extra={**_C, "source": "slack", "resource_type": "thread", "resource_id": res_id},
        )


async def _clear_pending(res_id: str) -> None:
    existing = await db.lookup_conversation("slack", "thread", res_id)
    if is_pending(existing):
        await db.clear_conversation("slack", "thread", res_id)
    await db.get_and_clear_pending_messages("slack", "thread", res_id)


class SlackReplyRequest(BaseModel):
    channel: str
    thread_ts: str
    text: str


@router.post("/slack/reply", dependencies=[Depends(require_relay_key)])
async def relay_slack_reply(request: Request, req: SlackReplyRequest):
    """Relay endpoint for agents to post Slack replies."""
    ts = await reply_in_thread(req.channel, req.thread_ts, req.text)
    if ts is None:
        raise HTTPException(status_code=502, detail="Failed to post Slack reply")
    return {"ok": True, "ts": ts}


# Discovered and mounted by the webhooks service via the entry-point registry; the handler self-gates in-route.
from scooter_webhooks_lib.registry import WebhookHandler, register_webhook

# Imported for their registration side effects.
from . import identity  # noqa: F401
from . import resources  # noqa: F401


@register_webhook
def slack() -> WebhookHandler:
    return WebhookHandler(name="slack", router=router)
