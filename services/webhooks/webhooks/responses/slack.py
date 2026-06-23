"""Post/update messages on Slack."""

import logging

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

SLACK_API = "https://slack.com/api"


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.slack_bot_token}",
        "Content-Type": "application/json; charset=utf-8",
    }


async def post_slack_message(channel: str, text: str, thread_ts: str | None = None) -> str | None:
    """Post a message to Slack. Returns message timestamp or None."""
    try:
        payload: dict = {"channel": channel, "text": text}
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
                logger.error("Slack postMessage failed: %s", data.get("error"))
                return None
            ts = data.get("ts")
            logger.info("Posted Slack message %s in %s", ts, channel)
            return ts
    except httpx.HTTPError as e:
        logger.error("Failed to post Slack message in %s: %s", channel, e)
        return None


async def update_slack_message(channel: str, ts: str, text: str) -> None:
    """Update an existing Slack message."""
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{SLACK_API}/chat.update",
                headers=_headers(),
                json={"channel": channel, "ts": ts, "text": text},
            )
            resp.raise_for_status()
            data = resp.json()
            if not data.get("ok"):
                logger.error("Slack chat.update failed: %s", data.get("error"))
            else:
                logger.debug("Updated Slack message %s in %s", ts, channel)
    except httpx.HTTPError as e:
        logger.error("Failed to update Slack message %s in %s: %s", ts, channel, e)


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
                logger.error("Slack reactions.add failed: %s", data.get("error"))
    except httpx.HTTPError as e:
        logger.error("Failed to add Slack reaction: %s", e)


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
                logger.error("Slack conversations.replies failed: %s", data.get("error"))
                return []
            return data.get("messages", [])
    except httpx.HTTPError as e:
        logger.error("Failed to get Slack thread history: %s", e)
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
                logger.error("Slack auth.test failed: %s", data.get("error"))
                return None
            return data.get("user_id")
    except httpx.HTTPError as e:
        logger.error("Failed to get Slack bot user ID: %s", e)
        return None


async def reply_in_thread(channel: str, thread_ts: str, text: str) -> str | None:
    """Reply in a Slack thread. Returns message timestamp or None."""
    return await post_slack_message(channel, text, thread_ts=thread_ts)
