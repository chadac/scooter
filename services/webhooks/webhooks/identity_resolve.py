"""Resolve an invoking external user (slack/github/gitlab) to their internal Scooter
user, by EMAIL, so a webhook-spawned conversation gets a real owner.

Flow (best-effort, non-blocking): the invoking external user id (from the webhook)
-> their EMAIL via the provider API -> the agent-host `/users/by-email` reverse
lookup over user_identity -> the Scooter user id. If any step can't resolve (no
token, no email on the account, no matching Scooter user), returns None and the
conversation stays unowned — exactly today's behavior. See todo/IDENTITY_MAPPING.md.
"""

from __future__ import annotations

import logging

import httpx

from .config import settings

logger = logging.getLogger(__name__)

_SLACK_API = "https://slack.com/api"
_GITHUB_API = "https://api.github.com"
_GITLAB_API = "https://gitlab.com/api/v4"


async def _slack_email(user_id: str) -> str | None:
    """The email for a Slack user id, via users.info (needs the users:read.email
    scope on the bot token). None if unavailable."""
    token = settings.slack_bot_token
    if not token or not user_id:
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{_SLACK_API}/users.info",
                headers={"Authorization": f"Bearer {token}"},
                params={"user": user_id},
            )
            data = resp.json()
        if not data.get("ok"):
            logger.info("slack users.info(%s) not ok: %s", user_id, data.get("error"))
            return None
        return (data.get("user", {}).get("profile", {}) or {}).get("email") or None
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("slack email lookup failed for %s: %s", user_id, e)
        return None


async def _github_email(login: str) -> str | None:
    """The PUBLIC email for a GitHub login (GET /users/{login}); often null (users
    keep it private). Best-effort — no App/token required for the public endpoint."""
    if not login:
        return None
    headers = {"Accept": "application/vnd.github+json"}
    if settings.github_token:
        headers["Authorization"] = f"Bearer {settings.github_token}"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(f"{_GITHUB_API}/users/{login}", headers=headers)
            if resp.status_code != 200:
                return None
            return resp.json().get("email") or None
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("github email lookup failed for %s: %s", login, e)
        return None


async def _gitlab_email(username: str) -> str | None:
    """The email for a GitLab username (GET /users?username=). Needs a token with
    scope to see the email (admin, or the user's own); often null otherwise."""
    token = settings.gitlab_token
    if not token or not username:
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{_GITLAB_API}/users",
                headers={"PRIVATE-TOKEN": token},
                params={"username": username},
            )
            if resp.status_code != 200:
                return None
            users = resp.json()
        if not isinstance(users, list) or not users:
            return None
        return users[0].get("email") or None
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("gitlab email lookup failed for %s: %s", username, e)
        return None


async def get_user_email(provider: str, external_id: str) -> str | None:
    """The email for an invoking external user, by provider. None if unavailable."""
    if provider == "slack":
        return await _slack_email(external_id)
    if provider == "github":
        return await _github_email(external_id)
    if provider == "gitlab":
        return await _gitlab_email(external_id)
    return None


async def _scooter_user_for_email(email: str) -> str | None:
    """Ask the agent-host which Scooter user has this email (user_identity). None if
    no match / unreachable."""
    base = settings.agent_host_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base}/users/by-email", params={"email": email})
            if resp.status_code != 200:
                return None
            return resp.json().get("id") or None
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("by-email lookup failed for %s: %s", email, e)
        return None


async def resolve_owner(provider: str, external_id: str) -> str | None:
    """Map an invoking external user -> their Scooter user id (the conversation
    owner), by email. Best-effort: any miss -> None (the conversation stays
    unowned). Never raises into the webhook path."""
    if not external_id:
        return None
    email = await get_user_email(provider, external_id)
    if not email:
        return None
    owner = await _scooter_user_for_email(email)
    if owner:
        logger.info("resolved %s user %s -> scooter user %s", provider, external_id, owner)
    return owner
