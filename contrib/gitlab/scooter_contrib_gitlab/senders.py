"""A GitLab message's sender: the numeric user id, leveled by project membership."""

from __future__ import annotations

import logging
import time

import httpx

from scooter_lib.logging_config import format_error
from scooter_webhooks_lib.sender import Level, Sender

from .config import settings
from .responses import GITLAB_API

logger = logging.getLogger(__name__)
_C = {"component": "senders.gitlab"}

# Developer: can push, so has standing in the project.
MEMBER_ACCESS_LEVEL = 30

# (project, user) -> (fetched at, access level; 0 if non-member).
_access_cache: dict[tuple[int, int], tuple[float, int]] = {}
_ACCESS_TTL_SECONDS = 300


async def project_access_level(project_id: int, user_id: int) -> int | None:
    """The user's project access level, inherited included; 0 for a non-member, None if unknown."""
    if not settings.gitlab_token:
        return None
    key = (project_id, user_id)
    cached = _access_cache.get(key)
    if cached and time.monotonic() - cached[0] < _ACCESS_TTL_SECONDS:
        return cached[1]
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITLAB_API}/projects/{project_id}/members/all/{user_id}",
                headers={"PRIVATE-TOKEN": settings.gitlab_token},
            )
        if resp.status_code == 404:
            level = 0
        else:
            resp.raise_for_status()
            level = int(resp.json().get("access_level") or 0)
    except (httpx.HTTPError, ValueError) as e:
        # Not cached, so the next message retries.
        logger.warning("project membership lookup failed", extra={**_C, "project_id": project_id, "error": format_error(e)})
        return None
    _access_cache[key] = (time.monotonic(), level)
    return level


def access_to_level(access: int | None) -> Level:
    """Developer and up is MEMBER, a lower role CONTRIBUTOR, a non-member GUEST."""
    if access is None:
        return Level.UNKNOWN
    if access >= MEMBER_ACCESS_LEVEL:
        return Level.MEMBER
    return Level.CONTRIBUTOR if access > 0 else Level.GUEST


def _int_id(value) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


async def sender_of(payload: dict) -> Sender | None:
    """The event's `user` as a Sender, or None when it has no numeric id."""
    user = payload.get("user") or {}
    uid = _int_id(user.get("id"))
    if uid is None:
        return None
    project_id = _int_id((payload.get("project") or {}).get("id"))
    access = await project_access_level(project_id, uid) if project_id is not None else None
    return Sender(
        provider="gitlab",
        external_id=str(uid),
        handle=user.get("username") or "",
        level=access_to_level(access),
        display_name=user.get("name") or None,
    )
