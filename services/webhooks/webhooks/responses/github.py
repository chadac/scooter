"""Post/update comments on GitHub issues and PRs.

Supports two auth modes:
1. GitHub App (preferred): generates JWT from App ID + private key,
   then exchanges for an installation access token.
2. PAT fallback: uses a static github_token.
"""

import logging
import time

import httpx
import jwt

from ..config import settings
from ..logging_config import format_error

logger = logging.getLogger(__name__)
_C = {"component": "responses.github"}

GITHUB_API = "https://api.github.com"

# Cache installation tokens (they last 1 hour, we refresh at 50 min)
_token_cache: dict[int, tuple[str, float]] = {}
_TOKEN_TTL = 50 * 60  # refresh 10 min before expiry


def _load_private_key() -> str | None:
    """Load the GitHub App private key from settings."""
    key = settings.github_app_private_key
    if not key:
        return None
    # If it looks like a file path, read it
    if not key.startswith("-----") and "/" in key:
        try:
            with open(key) as f:
                return f.read()
        except OSError as e:
            logger.error(
                "read of github app private key failed",
                extra={**_C, "key_path": key, "error": format_error(e)},
            )
            return None
    return key


def _generate_jwt() -> str | None:
    """Generate a JWT for GitHub App authentication."""
    private_key = _load_private_key()
    if not private_key or not settings.github_app_id:
        return None
    now = int(time.time())
    payload = {
        "iat": now - 60,  # issued at (60s in past for clock drift)
        "exp": now + (10 * 60),  # expires in 10 minutes
        "iss": settings.github_app_id,  # GitHub App ID (can be client_id)
    }
    return jwt.encode(payload, private_key, algorithm="RS256")


async def _get_installation_token(installation_id: int) -> str | None:
    """Get an installation access token, using cache when possible."""
    cached = _token_cache.get(installation_id)
    if cached and time.time() < cached[1]:
        return cached[0]

    app_jwt = _generate_jwt()
    if not app_jwt:
        return None

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{GITHUB_API}/app/installations/{installation_id}/access_tokens",
                headers={
                    "Authorization": f"Bearer {app_jwt}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            resp.raise_for_status()
            token = resp.json()["token"]
            _token_cache[installation_id] = (token, time.time() + _TOKEN_TTL)
            return token
    except httpx.HTTPError as e:
        logger.error(
            "get installation token failed",
            extra={**_C, "installation_id": installation_id, "error": format_error(e)},
        )
        return None


async def _get_installation_id_for_repo(owner: str, repo: str) -> int | None:
    """Look up the installation ID for a given repo."""
    app_jwt = _generate_jwt()
    if not app_jwt:
        return None

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/installation",
                headers={
                    "Authorization": f"Bearer {app_jwt}",
                    "Accept": "application/vnd.github+json",
                    "X-GitHub-Api-Version": "2022-11-28",
                },
            )
            resp.raise_for_status()
            return resp.json()["id"]
    except httpx.HTTPError as e:
        logger.error(
            "get installation id failed",
            extra={**_C, "repo_owner": owner, "repo": repo, "error": format_error(e)},
        )
        return None


# Cache installation IDs per repo
_installation_cache: dict[str, int] = {}


async def _headers_for_repo(owner: str, repo: str) -> dict[str, str]:
    """Get auth headers for a specific repo."""
    base_headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    # Try GitHub App auth first
    if settings.github_app_id and settings.github_app_private_key:
        cache_key = f"{owner}/{repo}"
        installation_id = _installation_cache.get(cache_key)
        if not installation_id:
            installation_id = await _get_installation_id_for_repo(owner, repo)
            if installation_id:
                _installation_cache[cache_key] = installation_id

        if installation_id:
            token = await _get_installation_token(installation_id)
            if token:
                base_headers["Authorization"] = f"Bearer {token}"
                return base_headers

    # Fallback to PAT
    if settings.github_token:
        base_headers["Authorization"] = f"Bearer {settings.github_token}"

    return base_headers


async def post_github_comment(
    owner: str, repo: str, issue_number: int, body: str,
) -> int | None:
    """Post a comment on a GitHub issue or PR. Returns comment ID or None."""
    try:
        headers = await _headers_for_repo(owner, repo)
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.post(
                f"{GITHUB_API}/repos/{owner}/{repo}/issues/{issue_number}/comments",
                headers=headers,
                json={"body": body},
            )
            resp.raise_for_status()
            data = resp.json()
            comment_id = data.get("id")
            logger.info(
                "posted comment",
                extra={
                    **_C,
                    "comment_id": comment_id,
                    "repo_owner": owner,
                    "repo": repo,
                    "issue_number": issue_number,
                },
            )
            return comment_id
    except httpx.HTTPError as e:
        logger.error(
            "post comment failed",
            extra={
                **_C,
                "repo_owner": owner,
                "repo": repo,
                "issue_number": issue_number,
                "error": format_error(e),
            },
        )
        return None


async def update_github_comment(
    owner: str, repo: str, comment_id: int, body: str,
) -> None:
    """Update an existing GitHub comment."""
    try:
        headers = await _headers_for_repo(owner, repo)
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.patch(
                f"{GITHUB_API}/repos/{owner}/{repo}/issues/comments/{comment_id}",
                headers=headers,
                json={"body": body},
            )
            resp.raise_for_status()
            logger.debug(
                "updated comment",
                extra={**_C, "comment_id": comment_id, "repo_owner": owner, "repo": repo},
            )
    except httpx.HTTPError as e:
        logger.error(
            "update comment failed",
            extra={
                **_C,
                "comment_id": comment_id,
                "repo_owner": owner,
                "repo": repo,
                "error": format_error(e),
            },
        )


async def get_issue_or_pr(owner: str, repo: str, number: int) -> dict | None:
    """Get an issue or PR by number."""
    try:
        headers = await _headers_for_repo(owner, repo)
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{GITHUB_API}/repos/{owner}/{repo}/issues/{number}",
                headers=headers,
            )
            resp.raise_for_status()
            return resp.json()
    except httpx.HTTPError as e:
        logger.error(
            "get issue failed",
            extra={
                **_C,
                "repo_owner": owner,
                "repo": repo,
                "issue_number": number,
                "error": format_error(e),
            },
        )
        return None
