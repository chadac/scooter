"""Post and update comments on GitLab issues and MRs."""

import logging

import httpx

from .config import settings
from scooter_lib.logging_config import format_error

logger = logging.getLogger(__name__)
_C = {"component": "responses.gitlab"}

GITLAB_API = f"https://{settings.gitlab_host}/api/v4"

# "" once looked up and absent; None until a lookup succeeds.
_own_username: str | None = None


async def get_own_username() -> str | None:
    """The username GITLAB_TOKEN posts as, cached for the process."""
    global _own_username
    if _own_username is not None:
        return _own_username or None
    if not settings.gitlab_token:
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{GITLAB_API}/user", headers={"PRIVATE-TOKEN": settings.gitlab_token})
            resp.raise_for_status()
            username = resp.json().get("username", "")
    except (httpx.HTTPError, ValueError) as e:
        # Left unset so a transient failure is retried.
        logger.error("get own username failed", extra={**_C, "error": format_error(e)})
        return None
    _own_username = username or ""
    return _own_username or None


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
