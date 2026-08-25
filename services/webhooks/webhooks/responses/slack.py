"""Post/update messages on Slack."""

import logging

import httpx

from ..config import settings
from ..logging_config import format_error

logger = logging.getLogger(__name__)
_C = {"component": "responses.slack"}

SLACK_API = "https://slack.com/api"


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.slack_bot_token}",
        "Content-Type": "application/json; charset=utf-8",
    }


async def post_slack_message(channel: str, text: str, thread_ts: str | None = None) -> str | None:
    """Post a message to Slack. Returns message timestamp or None."""
    try:
        # unfurl_* off: Scooter's messages are status/link notices (e.g. the "on it —
        # follow along: <chat url|View conversation>" and PR links). Slack's default
        # link/media unfurl renders a large, useless preview card that eats vertical
        # space — suppress it for every bot message.
        payload: dict = {
            "channel": channel,
            "text": text,
            "unfurl_links": False,
            "unfurl_media": False,
        }
        if thread_ts:
            payload["thread_ts"] = thread_ts
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{SLACK_API}/chat.postMessage",
                headers=_headers(),
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("ok"):
                logger.error(
                    "slack api call not ok",
                    extra={
                        **_C,
                        "slack_method": "chat.postMessage",
                        "slack_error": data.get("error"),
                        "channel": channel,
                        "thread_ts": thread_ts,
                    },
                )
                return None
            ts = data.get("ts")
            logger.info(
                "posted message",
                extra={**_C, "message_ts": ts, "channel": channel, "thread_ts": thread_ts},
            )
            return ts
    except httpx.HTTPError as e:
        logger.error(
            "slack api request failed",
            extra={
                **_C,
                "slack_method": "chat.postMessage",
                "channel": channel,
                "thread_ts": thread_ts,
                "error": format_error(e),
            },
        )
        return None


async def update_slack_message(channel: str, ts: str, text: str) -> None:
    """Update an existing Slack message."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{SLACK_API}/chat.update",
                headers=_headers(),
                # unfurl off (as in post_slack_message) — this edits the same
                # status/link messages, so keep the preview suppressed on updates too.
                json={
                    "channel": channel,
                    "ts": ts,
                    "text": text,
                    "unfurl_links": False,
                    "unfurl_media": False,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("ok"):
                logger.error(
                    "slack api call not ok",
                    extra={
                        **_C,
                        "slack_method": "chat.update",
                        "slack_error": data.get("error"),
                        "channel": channel,
                        "message_ts": ts,
                    },
                )
            else:
                logger.debug(
                    "updated message",
                    extra={**_C, "message_ts": ts, "channel": channel},
                )
    except httpx.HTTPError as e:
        logger.error(
            "slack api request failed",
            extra={
                **_C,
                "slack_method": "chat.update",
                "channel": channel,
                "message_ts": ts,
                "error": format_error(e),
            },
        )


async def add_slack_reaction(channel: str, ts: str, name: str) -> None:
    """Add a reaction emoji to a Slack message."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{SLACK_API}/reactions.add",
                headers=_headers(),
                json={"channel": channel, "timestamp": ts, "name": name},
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("ok") and data.get("error") != "already_reacted":
                logger.error(
                    "slack api call not ok",
                    extra={
                        **_C,
                        "slack_method": "reactions.add",
                        "slack_error": data.get("error"),
                        "channel": channel,
                        "message_ts": ts,
                        "reaction": name,
                    },
                )
    except httpx.HTTPError as e:
        logger.error(
            "slack api request failed",
            extra={
                **_C,
                "slack_method": "reactions.add",
                "channel": channel,
                "message_ts": ts,
                "reaction": name,
                "error": format_error(e),
            },
        )


async def get_thread_history(channel: str, thread_ts: str) -> list[dict]:
    """Get message history for a Slack thread."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{SLACK_API}/conversations.replies",
                headers=_headers(),
                params={"channel": channel, "ts": thread_ts, "limit": 100},
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("ok"):
                logger.error(
                    "slack api call not ok",
                    extra={
                        **_C,
                        "slack_method": "conversations.replies",
                        "slack_error": data.get("error"),
                        "channel": channel,
                        "thread_ts": thread_ts,
                    },
                )
                return []
            return data.get("messages", [])
    except httpx.HTTPError as e:
        logger.error(
            "slack api request failed",
            extra={
                **_C,
                "slack_method": "conversations.replies",
                "channel": channel,
                "thread_ts": thread_ts,
                "error": format_error(e),
            },
        )
        return []


async def get_bot_user_id() -> str | None:
    """Get the bot's own Slack user ID."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{SLACK_API}/auth.test",
                headers=_headers(),
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("ok"):
                logger.error(
                    "slack api call not ok",
                    extra={**_C, "slack_method": "auth.test", "slack_error": data.get("error")},
                )
                return None
            return data.get("user_id")
    except httpx.HTTPError as e:
        logger.error(
            "slack api request failed",
            extra={**_C, "slack_method": "auth.test", "error": format_error(e)},
        )
        return None


async def reply_in_thread(channel: str, thread_ts: str, text: str) -> str | None:
    """Reply in a Slack thread. Returns message timestamp or None."""
    return await post_slack_message(channel, text, thread_ts=thread_ts)
