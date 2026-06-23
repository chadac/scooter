"""Post/update comments on Jira issues via Atlassian OAuth 2.0."""

import logging
import time

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

_token_cache: dict[str, str | float] = {}


def jira_browse_url(issue_key: str) -> str:
    """Build a human-readable Jira issue URL."""
    cloud_id = settings.atlassian_cloud_id
    return f"https://api.atlassian.com/ex/jira/{cloud_id}/browse/{issue_key}"


async def _get_access_token() -> str | None:
    """Get an Atlassian OAuth 2.0 access token, refreshing if needed."""
    now = time.time()
    cached_token = _token_cache.get("token")
    expires_at = _token_cache.get("expires_at", 0)

    if cached_token and isinstance(expires_at, (int, float)) and now < expires_at:
        return str(cached_token)

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                "https://auth.atlassian.com/oauth/token",
                json={
                    "grant_type": "client_credentials",
                    "client_id": settings.atlassian_client_id,
                    "client_secret": settings.atlassian_client_secret,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            token = data["access_token"]
            expires_in = data.get("expires_in", 3600)
            _token_cache["token"] = token
            _token_cache["expires_at"] = now + expires_in - 60  # refresh 60s early
            return token
    except httpx.HTTPError as e:
        logger.error("Failed to get Atlassian OAuth token: %s", e)
        return None


def _api_base() -> str:
    cloud_id = settings.atlassian_cloud_id
    return f"https://api.atlassian.com/ex/jira/{cloud_id}/rest/api/3"


async def _headers() -> dict[str, str]:
    token = await _get_access_token()
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


async def post_jira_comment(issue_key: str, body: str) -> str | None:
    """Post a comment on a Jira issue. Returns comment ID or None."""
    try:
        headers = await _headers()
        # Jira Cloud API v3 uses ADF (Atlassian Document Format)
        adf_body = {
            "body": {
                "version": 1,
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": body}],
                    }
                ],
            }
        }
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{_api_base()}/issue/{issue_key}/comment",
                headers=headers,
                json=adf_body,
            )
            resp.raise_for_status()
            data = resp.json()
            comment_id = data.get("id")
            logger.info("Posted Jira comment %s on %s", comment_id, issue_key)
            return comment_id
    except httpx.HTTPError as e:
        logger.error("Failed to post Jira comment on %s: %s", issue_key, e)
        return None


async def update_jira_comment(issue_key: str, comment_id: str, body: str) -> None:
    """Update an existing Jira comment."""
    try:
        headers = await _headers()
        adf_body = {
            "body": {
                "version": 1,
                "type": "doc",
                "content": [
                    {
                        "type": "paragraph",
                        "content": [{"type": "text", "text": body}],
                    }
                ],
            }
        }
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.put(
                f"{_api_base()}/issue/{issue_key}/comment/{comment_id}",
                headers=headers,
                json=adf_body,
            )
            resp.raise_for_status()
            logger.debug("Updated Jira comment %s on %s", comment_id, issue_key)
    except httpx.HTTPError as e:
        logger.error("Failed to update Jira comment %s on %s: %s", comment_id, issue_key, e)


async def get_jira_issue(issue_key: str) -> dict | None:
    """Get a Jira issue by key."""
    try:
        headers = await _headers()
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{_api_base()}/issue/{issue_key}",
                headers=headers,
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError as e:
        logger.error("Failed to get Jira issue %s: %s", issue_key, e)
        return None
