"""Post/update comments on GitLab issues and MRs."""

import logging

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

GITLAB_API = "https://gitlab.com/api/v4"


async def post_gitlab_comment(
    project_id: int, noteable_type: str, noteable_iid: int, body: str,
) -> int | None:
    """Post a comment on a GitLab issue or MR. Returns note ID or None."""
    if not settings.gitlab_token:
        logger.warning("GITLAB_TOKEN not set -- skipping comment post")
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
            logger.info("Posted comment on %s %s/%s", noteable_type, project_id, noteable_iid)
            return resp.json().get("id")
    except httpx.HTTPError as e:
        logger.error("Failed to post GitLab comment: %s", e)
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
        logger.error("Failed to update GitLab comment: %s", e)
