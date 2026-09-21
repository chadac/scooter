"""Resolve an invoking external user to their internal Scooter user, by EMAIL, so a
webhook-spawned conversation gets a real owner.

Flow (best-effort, non-blocking): the invoking external user id (from the webhook)
-> their EMAIL via the provider API -> the agent-host `/users/by-email` reverse
lookup over user_identity -> the Scooter user id. Any step failing to resolve (no
token, no email on the account, no matching Scooter user) yields None and the
conversation stays unowned. See todo/IDENTITY_MAPPING.md.

The per-provider email lookup is REGISTERED, not dispatched: this module used to
hold `if provider == "slack" / "github" / "gitlab"` chains plus three provider API
clients, which is the same shape the provider registries replaced. Each lookup now
travels with its provider's contrib, and a provider Scooter doesn't ship simply has
no resolver. Why: PR #575.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from scooter_lib.logging_config import format_error, pseudonym

from .agent_host_client import user_id_for_email

logger = logging.getLogger(__name__)
_C = {"component": "identity"}

EmailResolver = Callable[[str], Awaitable[str | None]]

_resolvers: dict[str, EmailResolver] = {}


def register_email_resolver(provider: str) -> Callable[[EmailResolver], EmailResolver]:
    """Register how to get an email for one provider's external user id.

    ``@register_email_resolver("github")`` on an ``async def (external_id) -> str |
    None``. Re-registering the same provider REPLACES it, so a contrib can override
    the in-tree lookup without the app knowing.
    """

    def decorate(fn: EmailResolver) -> EmailResolver:
        _resolvers[provider] = fn
        return fn

    return decorate


def registered_providers() -> list[str]:
    """Which providers can resolve an owner, for diagnostics."""
    return sorted(_resolvers)


async def get_user_email(provider: str, external_id: str) -> str | None:
    """The email for an invoking external user. None if the provider has no
    registered resolver, or the lookup can't answer."""
    resolver = _resolvers.get(provider)
    if resolver is None or not external_id:
        return None
    try:
        return await resolver(external_id)
    except Exception as e:
        # A resolver is third-party code in a contrib; a raise here would take down a
        # webhook delivery over a best-effort ownership lookup.
        logger.warning(
            "email resolver failed",
            extra={**_C, "provider": provider, "external_user": pseudonym(external_id), "error": format_error(e)},
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
    owner = await user_id_for_email(email)
    if owner:
        logger.info(
            "resolved external user to scooter user",
            extra={**_C, "provider": provider, "user_id": pseudonym(owner)},
        )
    return owner
