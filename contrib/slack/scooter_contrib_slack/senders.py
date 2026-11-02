"""A Slack message's sender: home team + user id, leveled by users.info."""

from __future__ import annotations

import logging
import time

import httpx

from scooter_lib.logging_config import format_error, pseudonym
from scooter_webhooks_lib.sender import Level, Sender

from .config import settings

logger = logging.getLogger(__name__)
_C = {"component": "contrib.slack.senders"}

_SLACK_API = "https://slack.com/api"

# user id -> (fetched at, users.info `user` object).
_user_cache: dict[str, tuple[float, dict]] = {}
_USER_TTL_SECONDS = 300
# Short: mentions are looked up within Slack's 3s ack.
_LOOKUP_TIMEOUT_SECONDS = 2


async def _user_info(user_id: str) -> dict | None:
    """users.info's `user` object, or None when the lookup fails."""
    token = settings.slack_bot_token
    if not token:
        return None
    cached = _user_cache.get(user_id)
    if cached and time.monotonic() - cached[0] < _USER_TTL_SECONDS:
        return cached[1]
    try:
        async with httpx.AsyncClient(timeout=_LOOKUP_TIMEOUT_SECONDS) as client:
            resp = await client.get(
                f"{_SLACK_API}/users.info",
                headers={"Authorization": f"Bearer {token}"},
                params={"user": user_id},
            )
            data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("users.info failed", extra={**_C, "external_user": pseudonym(user_id), "error": format_error(e)})
        return None
    if not data.get("ok") or not isinstance(data.get("user"), dict):
        logger.info("users.info not ok", extra={**_C, "external_user": pseudonym(user_id), "slack_error": data.get("error")})
        return None
    _user_cache[user_id] = (time.monotonic(), data["user"])
    return data["user"]


def info_to_level(info: dict | None, workspace: str) -> Level:
    """A full user of this workspace is MEMBER; a guest or Slack Connect user is GUEST."""
    if info is None or not workspace:
        return Level.UNKNOWN
    if info.get("deleted"):
        return Level.UNKNOWN
    if info.get("is_restricted") or info.get("is_ultra_restricted") or info.get("is_stranger"):
        return Level.GUEST
    return Level.MEMBER if info.get("team_id") == workspace else Level.GUEST


async def sender_of(event: dict, workspace: str) -> Sender | None:
    """The event's user as a Sender, or None without a user and a home team."""
    user_id = event.get("user") or ""
    # user_team is the home team; differs under Slack Connect.
    team = event.get("user_team") or event.get("team") or workspace
    if not user_id or not team:
        return None
    info = await _user_info(user_id)
    profile = (info or {}).get("profile") or {}
    return Sender(
        provider="slack",
        external_id=f"{team}:{user_id}",
        handle=(info or {}).get("name") or user_id,
        level=info_to_level(info, workspace),
        display_name=profile.get("display_name") or profile.get("real_name") or None,
    )
