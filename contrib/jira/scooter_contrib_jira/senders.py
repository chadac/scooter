"""A Jira message's sender: the accountId, leveled by account type and project permission."""

from __future__ import annotations

import logging
import time

import httpx

from scooter_lib.logging_config import format_error, pseudonym
from scooter_webhooks_lib.sender import Level, Sender

from .responses import _api_base, _headers

logger = logging.getLogger(__name__)
_C = {"component": "senders.jira"}

# A project role grants issue edits; commenting alone doesn't.
MEMBER_PERMISSION = "EDIT_ISSUES"

# (project key, accountId) -> (fetched at, has the permission).
_permission_cache: dict[tuple[str, str], tuple[float, bool]] = {}
_PERMISSION_TTL_SECONDS = 300


async def can_edit_issues(project_key: str, account_id: str) -> bool | None:
    """Whether the account holds MEMBER_PERMISSION in the project, or None if unknown."""
    key = (project_key, account_id)
    cached = _permission_cache.get(key)
    if cached and time.monotonic() - cached[0] < _PERMISSION_TTL_SECONDS:
        return cached[1]
    try:
        headers = await _headers()
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{_api_base()}/user/permission/search",
                headers=headers,
                params={"projectKey": project_key, "accountId": account_id, "permissions": MEMBER_PERMISSION},
            )
            resp.raise_for_status()
            users = resp.json()
        allowed = isinstance(users, list) and any(u.get("accountId") == account_id for u in users)
    except (httpx.HTTPError, ValueError, AttributeError) as e:
        # Not cached, so the next message retries.
        logger.warning(
            "project permission lookup failed",
            extra={**_C, "project_key": project_key, "external_user": pseudonym(account_id), "error": format_error(e)},
        )
        return None
    _permission_cache[key] = (time.monotonic(), allowed)
    return allowed


def project_key_of(issue: dict) -> str:
    """The issue's project key, from its fields or its key's prefix."""
    key = ((issue.get("fields") or {}).get("project") or {}).get("key")
    if key:
        return key
    issue_key = issue.get("key") or ""
    return issue_key.rsplit("-", 1)[0] if "-" in issue_key else ""


async def sender_of(account: dict | None, issue: dict) -> Sender | None:
    """`account` (a comment author or event user) as a Sender, or None without an accountId."""
    account = account or {}
    account_id = account.get("accountId") or ""
    if not account_id:
        return None
    kind = account.get("accountType")
    if kind == "customer":
        level = Level.GUEST
    elif kind == "atlassian":
        project = project_key_of(issue)
        allowed = await can_edit_issues(project, account_id) if project else None
        level = Level.UNKNOWN if allowed is None else (Level.MEMBER if allowed else Level.CONTRIBUTOR)
    else:
        level = Level.UNKNOWN
    name = account.get("displayName") or None
    return Sender(provider="jira", external_id=account_id, handle=name or account_id, level=level, display_name=name)
