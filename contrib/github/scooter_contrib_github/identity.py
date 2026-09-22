"""Owner resolution for GitHub: a login -> the email Scooter matches on.

Registered into `scooter_webhooks_lib.identity`, which owns the orchestration
(#575). This is the provider-specific half that used to sit in the webhooks app's
`identity_resolve`. Why: PR #591.
"""

from __future__ import annotations

import logging

import httpx

from scooter_lib.logging_config import format_error, pseudonym
from scooter_webhooks_lib.identity import register_email_resolver

from .config import settings

logger = logging.getLogger(__name__)
_C = {"component": "contrib.github.identity"}

_GITHUB_API = "https://api.github.com"


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
