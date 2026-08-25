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

import hashlib

import httpx

from .config import settings
from .logging_config import format_error

logger = logging.getLogger(__name__)
_C = {"component": "identity_resolve"}


def pseudonym(value: str | None) -> str | None:
    """A stable, non-reversible stand-in for an identifier, for logs.

    WHAT TO PASS. Preferably the SCOOTER USER ID — the `user_identity.id` our own database
    assigns. That is already an internal handle rather than personal data, so
    pseudonymizing it is belt-and-braces: even the internal id never reaches the log
    store, and a leaked log cannot be joined against a database dump.

    External identifiers (a Slack user id, a GitHub login, an email) are personal data and
    must NEVER be logged raw either. They are pseudonymized too, but they go in their OWN
    fields — `external_user`, `email` — never in `user_id`.

    That separation matters. A pseudonym of an email and a pseudonym of a Scooter user id
    are DIFFERENT tokens for the same person. Putting both under `user_id` would make the
    field mean two things depending on how far resolution got: a query grouping by
    `user_id` would split one human into several, and a reader would have no way to tell
    why some lines carry an id that joins to nothing. One field, one meaning — `user_id`
    is the Scooter user and nothing else, and its absence is itself the signal that
    resolution never got that far.

    WHY A PSEUDONYM AND NOT NOTHING. Support ("user X says the bot ignored them") needs to
    find the line, and a lookup failure is undiagnosable without knowing whether the SAME
    principal keeps failing. A stable token keeps correlation across lines and restarts;
    it just does not say who.

    WHY A PLAIN DIGEST AND NOT AN HMAC. An HMAC needs a key. Keying off the per-provider
    webhook secrets would silently break correlation the moment one rotates — the same
    user would start producing a different token — and there is no other stable secret
    here. The threat model is "an operator reading logs should not see identities", not
    "an attacker holding the log store must not brute-force them"; the Slack-id input
    space is small enough that a keyless digest is reversible by someone determined, and
    that limit is stated rather than papered over. Raising that bar needs a dedicated
    pseudonym key, which is a deployment concern rather than a code one.

    12 hex chars: collision-safe at this cardinality, short enough to eyeball.

    NOT CACHED, deliberately. Measured at 0.34 us per call, and the call sites here are
    mutually exclusive — AT MOST ONE fires per webhook delivery, so there is nothing to
    amortize. A cache would add an unbounded dict keyed by exactly the personal data this
    function exists to keep out of memory-dumpable structures, to save one hash. If a
    caller ever needs this per-user rather than per-request, the right home is a cached
    attribute on the user record in the agent-host identity store (where the model
    actually lives) — not a module-level map in the service that only sees id strings.
    """
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


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
        logger.warning(
            "email lookup failed",
            extra={**_C, "provider": "github", "external_user": pseudonym(login), "error": format_error(e)},
        )
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
        logger.warning(
            "email lookup failed",
            extra={**_C, "provider": "gitlab", "external_user": pseudonym(username), "error": format_error(e)},
        )
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
        # DOMAIN only, not the address. The pre-conversion line interpolated the full
        # address, but promoting it to a structured, INDEXED field changes its retention
        # and searchability in the log store — that is a privacy decision, not a
        # formatting one, and the domain is what actually helps diagnose a lookup failure.
        logger.warning(
            "by-email lookup failed",
            extra={
                **_C,
                # The email itself never reaches the log. The domain stays because it is
                # what actually distinguishes a misconfigured tenant from a missing user,
                # and it identifies an organisation rather than a person.
                "email": pseudonym(email),
                "email_domain": email.rpartition("@")[2] or None,
                "error": format_error(e),
            },
        )
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
        logger.info(
            "resolved external user to scooter user",
            extra={
                **_C,
                "provider": provider,
                # The SCOOTER user id (user_identity.id), not the external one — this is
                # the identifier the rest of the system keys on, so it is what makes a log
                # line joinable to a conversation's owner. Pseudonymized even though it is
                # already internal: a leaked log then cannot be joined against a database
                # dump either.
                "user_id": pseudonym(owner),
            },
        )
    return owner
