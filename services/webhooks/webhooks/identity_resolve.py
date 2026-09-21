"""The per-provider email lookups behind owner resolution.

The orchestration (registry, agent-host reverse lookup, `resolve_owner`) is in
`scooter_webhooks_lib.identity`. What stays here is the part that is genuinely
provider-specific: how to ask slack/github/gitlab for a user's email, and the
token each needs. Each of these travels into its provider's contrib as that
provider migrates (#576+), at which point this module goes away entirely.

Imported for its REGISTRATION side effect — `app.py` imports it at startup, and
the decorators populate the lib's resolver registry. Why: PR #575.
"""

from __future__ import annotations

import logging

import httpx

from scooter_lib.logging_config import format_error, pseudonym
from scooter_webhooks_lib.identity import register_email_resolver

from .config import settings

logger = logging.getLogger(__name__)
_C = {"component": "identity_resolve"}

_SLACK_API = "https://slack.com/api"
_GITHUB_API = "https://api.github.com"
_GITLAB_API = "https://gitlab.com/api/v4"


@register_email_resolver("slack")
async def slack_email(user_id: str) -> str | None:
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
            logger.info(
                "slack users.info not ok",
                extra={**_C, "provider": "slack", "external_user": pseudonym(user_id), "slack_error": data.get("error")},
            )
            return None
        return (data.get("user", {}).get("profile", {}) or {}).get("email") or None
    except (httpx.HTTPError, ValueError) as e:
        logger.warning(
            "email lookup failed",
            extra={**_C, "provider": "slack", "external_user": pseudonym(user_id), "error": format_error(e)},
        )
        return None


@register_email_resolver("github")
async def github_email(login: str) -> str | None:
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
        logger.warning(
            "email lookup failed",
            extra={**_C, "provider": "github", "external_user": pseudonym(login), "error": format_error(e)},
        )
        return None


@register_email_resolver("gitlab")
async def gitlab_email(username: str) -> str | None:
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
        logger.warning(
            "email lookup failed",
            extra={**_C, "provider": "gitlab", "external_user": pseudonym(username), "error": format_error(e)},
        )
        return None
