"""Post/update comments on GitLab issues and MRs."""

import logging

import httpx

from ..config import settings
from ..logging_config import format_error

logger = logging.getLogger(__name__)
_C = {"component": "responses.gitlab"}

GITLAB_API = "https://gitlab.com/api/v4"


async def post_gitlab_comment(
    project_id: int, noteable_type: str, noteable_iid: int, body: str,
) -> int | None:
    """Post a comment on a GitLab issue or MR. Returns note ID or None."""
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
