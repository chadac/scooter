"""GitLab comments on issues and MRs, and project membership."""

import logging
import time

import httpx

from .config import settings
from scooter_lib.logging_config import format_error

logger = logging.getLogger(__name__)
_C = {"component": "responses.gitlab"}

GITLAB_API = f"https://{settings.gitlab_host}/api/v4"


async def post_gitlab_comment(
    project_id: int, noteable_type: str, noteable_iid: int, body: str,
) -> int | None:
    """Post a comment on a GitLab issue or MR, returning the note id or None."""
    if not settings.gitlab_token:
        logger.warning(
            "gitlab token not set, skipping comment post",
            extra={**_C, "project_id": project_id, "noteable_type": noteable_type, "noteable_iid": noteable_iid},
        )
        return None

    url = f"{GITLAB_API}/projects/{project_id}/{noteable_type}/{noteable_iid}/notes"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                url,
                headers={"PRIVATE-TOKEN": settings.gitlab_token},
                json={"body": body},
            )
            resp.raise_for_status()
            logger.info(
                "posted comment",
                extra={**_C, "noteable_type": noteable_type, "project_id": project_id, "noteable_iid": noteable_iid},
            )
            return resp.json().get("id")
    except httpx.HTTPError as e:
        logger.error(
            "post comment failed",
            extra={
                **_C,
                "project_id": project_id,
                "noteable_type": noteable_type,
                "noteable_iid": noteable_iid,
                "error": format_error(e),
            },
        )
    return None


async def update_gitlab_comment(
    project_id: int, noteable_type: str, noteable_iid: int, note_id: int, body: str,
) -> None:
    """Update an existing GitLab comment."""
    if not settings.gitlab_token:
        return

    url = f"{GITLAB_API}/projects/{project_id}/{noteable_type}/{noteable_iid}/notes/{note_id}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.put(
                url,
                headers={"PRIVATE-TOKEN": settings.gitlab_token},
                json={"body": body},
            )
            resp.raise_for_status()
    except httpx.HTTPError as e:
        logger.error(
            "update comment failed",
            extra={
                **_C,
                "project_id": project_id,
                "noteable_type": noteable_type,
                "noteable_iid": noteable_iid,
                "note_id": note_id,
                "error": format_error(e),
            },
        )


# (project_id, user_id) -> (fetched at, access level).
_access_cache: dict[tuple[int, int], tuple[float, int]] = {}
_ACCESS_TTL_SECONDS = 300


async def project_access_level(project_id: int | None, user_id: int | None) -> int:
    """The user's project access level, inherited included; 0 if unknown."""
    if not project_id or not user_id or not settings.gitlab_token:
        return 0
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
        # Uncached, so the next comment retries.
        logger.warning("project membership lookup failed", extra={**_C, "project_id": project_id, "error": format_error(e)})
        return 0
    _access_cache[key] = (time.monotonic(), level)
    return level
