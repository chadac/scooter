"""Slack webhook handler.

Trigger rules:
- @openhands mention in a channel -> creates/forwards conversation
- Any message in a thread with active conversation -> auto-forwarded
"""

import asyncio
import hashlib
import hmac
import logging
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from .. import store as db
from ..store import PENDING_CONVERSATION_ID, is_pending

from ..config import require_relay_key, settings
from ..agent_host_client import conversation_url, create_conversation, push_link, send_message
from ..responses.slack import (
    add_slack_reaction,
    get_bot_user_id,
    get_thread_history,
    post_slack_message,
    reply_in_thread,
)

logger = logging.getLogger(__name__)
router = APIRouter()

_bot_user_id: str | None = None

# Idempotency guard for the Slack Events API. Slack DELIVERS THE SAME EVENT MORE
# THAN ONCE: it retries (up to 3×, with an X-Slack-Retry-Num header) whenever it
# doesn't get a 200 within ~3s, and it can deliver both an `app_mention` AND a
# `message` event for the same mention. Every delivery carries a stable outer
# `event_id`; we drop any event_id we've already handled so a single user message
# creates exactly one conversation / one reply. The webhooks service runs a single
# replica (see modules/webhooks.nix), so an in-process guard is sufficient — no
# cross-pod store needed. Bounded FIFO so it can't grow without limit.
from collections import OrderedDict

_SEEN_EVENT_IDS: "OrderedDict[str, None]" = OrderedDict()
_SEEN_EVENT_IDS_MAX = 4096


def _already_handled(event_id: str) -> bool:
    """True if this Slack event_id was seen before (a retry / duplicate delivery)."""
    if not event_id:
        return False  # no id to dedupe on — let it through
    if event_id in _SEEN_EVENT_IDS:
        return True
    _SEEN_EVENT_IDS[event_id] = None
    while len(_SEEN_EVENT_IDS) > _SEEN_EVENT_IDS_MAX:
        _SEEN_EVENT_IDS.popitem(last=False)
    return False


def _verify_slack_signature(body: bytes, timestamp: str, signature: str) -> bool:
    if not settings.slack_signing_secret:
        return True
    if abs(time.time() - int(timestamp)) > 60 * 5:
        return False
    sig_basestring = f"v0:{timestamp}:{body.decode('utf-8')}"
    expected = "v0=" + hmac.new(
        settings.slack_signing_secret.encode(),
        sig_basestring.encode(),
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(expected, signature)


def _contains_mention(text: str) -> bool:
    return settings.mention_pattern.lower() in text.lower()


def _is_ignored_user(user_id: str) -> bool:
    if not settings.ignore_usernames:
        return False
    ignored = {u.strip().lower() for u in settings.ignore_usernames.split(",")}
    return user_id.lower() in ignored


def _resource_id(channel: str, thread_ts: str) -> str:
    return f"{channel}:{thread_ts}"


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
        f"provide the text)."
    )
    return f"{preamble}\n\n---\n\n{comment_body}{reply_hint}"


def _response_instructions(channel: str, thread_ts: str) -> str:
    return (
        f"\n\n---\n"
        f"**Response workflow:** First, post an acknowledgment in the Slack thread so the requester knows you've seen it. "
        f"Then work on the task. When finished, post a follow-up message with your results.\n\n"
        f"To respond in the Slack thread, use the `slack_respond` tool with your message text — "
        f"the thread ({channel}) is already known, so you only supply the `text`.\n\n"
        f"(The raw broker endpoint `$BROKER_URL/slack/chat.postMessage` still exists and returns the same errors, "
        f"but prefer the tool.)"
    )


@router.post("/webhooks/slack")
async def handle_slack_event(request: Request):
    """Receive Slack Events API callbacks (app_mention, message)."""
    if not settings.slack_enabled:
        return {"status": "disabled"}

    body = await request.body()
    payload = await request.json()

    # Handle Slack URL verification challenge
    if payload.get("type") == "url_verification":
        return {"challenge": payload.get("challenge", "")}

    # Verify signature
    timestamp = request.headers.get("x-slack-request-timestamp", "")
    signature = request.headers.get("x-slack-signature", "")
    if not _verify_slack_signature(body, timestamp, signature):
        raise HTTPException(status_code=401, detail="Invalid Slack signature")

    event_type = payload.get("type", "")

    if event_type == "event_callback":
        # Drop retries / duplicate deliveries of the same event so one user
        # message doesn't create two conversations / two replies. `event_id` is
        # stable across Slack's retries; the X-Slack-Retry-Num header (present
        # only on retries) is a fast secondary signal we can log.
        event_id = payload.get("event_id", "")
        if _already_handled(event_id):
            retry = request.headers.get("x-slack-retry-num", "")
            logger.info(
                "Slack event %s already handled — dropping duplicate%s",
                event_id,
                f" (retry {retry})" if retry else "",
            )
            return {"status": "ok", "deduped": True}
        event = payload.get("event", {})
        await _handle_event(event)

    return {"status": "ok"}


async def _get_bot_id() -> str | None:
    global _bot_user_id
    if _bot_user_id is None:
        _bot_user_id = await get_bot_user_id()
    return _bot_user_id


async def _handle_event(event: dict):
    event_type = event.get("type", "")
    subtype = event.get("subtype", "")

    # Ignore bot messages and message changes
    if subtype in ("bot_message", "message_changed", "message_deleted"):
        return

    # Ignore own messages
    bot_id = await _get_bot_id()
    user = event.get("user", "")
    if bot_id and user == bot_id:
        return

    if event_type == "app_mention":
        await _handle_mention(event)
    elif event_type == "message":
        await _handle_thread_message(event)


async def _format_thread_history(channel: str, thread_ts: str, up_to_ts: str) -> str:
    """When @scooter is mentioned INSIDE an existing thread, the agent otherwise
    sees only the single mention message and loses the conversation it's being
    pulled into — so it replies out of context. Fetch the thread's prior messages
    (conversations.replies) and format them as context, up to (but not including)
    the mention itself. Returns "" for a root-level mention (no prior history) or
    on any fetch failure (best-effort — a missing history must not block the reply).
    """
    try:
        messages = await get_thread_history(channel, thread_ts)
    except Exception:
        logger.exception("Failed to fetch Slack thread history for %s/%s", channel, thread_ts)
        return ""
    bot_id = await _get_bot_id()
    lines: list[str] = []
    for m in messages:
        m_ts = m.get("ts", "")
        # Stop at the mention message (it's already the current request) + skip our
        # own bot posts (status/acks — not part of the human conversation).
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


async def _handle_mention(event: dict):
    """Handle app_mention events — user mentioned @scooter."""
    text = event.get("text", "")
    user = event.get("user", "unknown")
    channel = event.get("channel", "")
    ts = event.get("ts", "")
    thread_ts = event.get("thread_ts", ts)  # If in thread, use thread_ts; otherwise use message ts

    if _is_ignored_user(user):
        return

    res_id = _resource_id(channel, thread_ts)

    existing = (
        await db.lookup_conversation("slack", "thread", res_id)
        or await db.get_conversation_for_resource("slack", "thread", res_id)
    )

    # Keep the message readable: rewrite the bot's own <@U…> mention to a plain
    # "@scooter" (so "@scooter please review" stays meaningful instead of becoming
    # "please review") and leave any OTHER user mentions intact.
    import re
    bot_id = await _get_bot_id()
    message_text = text.strip()
    if bot_id:
        message_text = re.sub(rf"<@{re.escape(bot_id)}>", settings.mention_pattern, message_text)
    message_text = message_text.strip()

    comment_text = f"<@{user}> said:\n\n{message_text}"

    if is_pending(existing):
        forward_msg = _format_forwarded_message(comment_text, channel, thread_ts, has_mention=True)
        await db.store_pending_message("slack", "thread", res_id, forward_msg)
        return

    if existing:
        # Forward to the existing conversation OFF the request path — send_message
        # blocks for the whole agent turn, which would blow Slack's retry window and
        # get every delivery dropped as a duplicate. React so the user sees it landed.
        forward_msg = _format_forwarded_message(comment_text, channel, thread_ts, has_mention=True)
        await add_slack_reaction(channel, ts, "eyes")
        asyncio.create_task(_background_forward(existing, forward_msg))
        return

    # React to indicate we're processing
    await add_slack_reaction(channel, ts, "eyes")

    await db.store_conversation("slack", "thread", res_id, PENDING_CONVERSATION_ID)

    # If the mention is INSIDE an existing thread (thread_ts != this message's ts),
    # publish the thread's prior history so the agent works from the real
    # conversation it was pulled into, not just the one mention message.
    history = ""
    if thread_ts and thread_ts != ts:
        history = await _format_thread_history(channel, thread_ts, up_to_ts=ts)

    reply_hint = _response_instructions(channel, thread_ts)
    prefix = f"{history}\n---\n\n" if history else ""
    full_message = f"{prefix}Slack message in channel {channel}:\n\n{comment_text}{reply_hint}"

    asyncio.create_task(
        _background_create_conversation(
            res_id=res_id, message=full_message,
            conv_title=f"Slack: {message_text[:50]}",
            channel=channel, thread_ts=thread_ts,
        )
    )


async def _handle_thread_message(event: dict):
    """Handle message events in threads with active conversations."""
    thread_ts = event.get("thread_ts")
    if not thread_ts:
        return  # Only handle threaded messages

    text = event.get("text", "")
    user = event.get("user", "unknown")
    channel = event.get("channel", "")

    if _is_ignored_user(user):
        return

    bot_id = await _get_bot_id()
    if bot_id and user == bot_id:
        return

    # A message that mentions @scooter ALSO arrives as a separate `app_mention`
    # event, which _handle_mention owns. Forwarding it here too would send the
    # agent TWO copies of the same message (the reported bug). Skip it — the
    # mention handler gives it the clearer "you were mentioned" framing.
    if _contains_mention(text):
        return

    res_id = _resource_id(channel, thread_ts)

    existing = (
        await db.lookup_conversation("slack", "thread", res_id)
        or await db.get_conversation_for_resource("slack", "thread", res_id)
    )

    if not existing:
        return

    comment_text = f"<@{user}> said:\n\n{text}"

    # No mention (guarded above) → a for-awareness thread message.
    if is_pending(existing):
        forward_msg = _format_forwarded_message(comment_text, channel, thread_ts, has_mention=False)
        await db.store_pending_message("slack", "thread", res_id, forward_msg)
        return

    # Forward OFF the request path (send_message blocks for the whole agent turn;
    # awaiting it here blows Slack's retry window → every delivery deduped).
    forward_msg = _format_forwarded_message(comment_text, channel, thread_ts, has_mention=False)
    asyncio.create_task(_background_forward(existing, forward_msg))


async def _background_forward(existing: str, forward_msg: str) -> None:
    """Forward a follow-up into an existing conversation OFF the request path.

    send_message blocks until the agent's whole turn finishes (the /agui SSE runs
    to RUN_FINISHED, minutes). Awaiting it inside the webhook handler blows Slack's
    ~3s window, so Slack retries — and every retry is dropped as a duplicate, so the
    channel looks dead ("everything classified as a duplicate on existing
    conversations"). Run it as a task so the handler can 200 immediately; the reply
    still streams into the thread via the agent's slack_respond."""
    ok = await send_message(existing, forward_msg)
    if not ok:
        logger.warning("Failed to forward message to conversation %s", existing)


async def _background_create_conversation(
    res_id: str, message: str, conv_title: str,
    channel: str, thread_ts: str,
) -> None:
    # Register the Slack thread anchor BEFORE the agent runs. create_conversation
    # blocks until the turn finishes, and the agent is instructed to acknowledge
    # first — so its FIRST slack_respond fires before this returns. If the link
    # (with ref.threadTs) isn't there yet, that first reply has no thread to infer
    # and escapes to the channel top-level (the reported bug). Pushing it in the
    # on_created hook (fired pre-run) guarantees the anchor exists from message 1.
    async def _register(conv_id: str) -> None:
        await db.store_conversation("slack", "thread", res_id, conv_id)
        # Persist slack_channel/slack_ts too, so the agent-host DB fallback resolves
        # the thread even if the link push is slow/lost.
        await db.store_slack_metadata(conv_id, channel, thread_ts)
        await push_link(
            conv_id, source="slack", resource_type="thread",
            title=f"{channel} thread",
            ref={"channel": channel, "threadTs": thread_ts},
        )
        # Post the "on it — follow along" link NOW, pre-run. create_conversation
        # blocks until the whole agent turn finishes, so posting the link after it
        # returned delayed it by the entire run (the 5-10min lag). The link only
        # needs conv_id (known here), so post it immediately.
        await post_slack_message(
            channel=channel,
            text=f"Scooter is on it — follow along: <{conversation_url(conv_id)}|View conversation>",
            thread_ts=thread_ts,
        )

    try:
        result = await create_conversation(message, title=conv_title, on_created=_register)
        if not result:
            await _clear_pending(res_id)
            # The optimistic "on it" ack already posted in _register; correct it.
            await post_slack_message(
                channel=channel,
                text="…actually, Scooter couldn't start on this one — failed to create the conversation.",
                thread_ts=thread_ts,
            )
            return

        if result.get("interrupted"):
            # The run was cut short by an agent-host restart; the conversation
            # exists and the agent-host resumes it on boot. Don't post a failure and
            # don't flush pending here — leave it to the resumed run.
            return

        conv_id = result.get("conversation_id", "")

        # Flush pending messages
        messages = await db.get_and_clear_pending_messages("slack", "thread", res_id)
        for msg in messages:
            ok = await send_message(conv_id, msg)
            if not ok:
                logger.warning("Failed to flush pending message to conversation %s", conv_id)
    except Exception:
        await _clear_pending(res_id)
        logger.exception("Error in background conversation creation for Slack %s", res_id)


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
