"""Whose personal credentials a request may use: the owner of an untainted private conversation, else nobody.

A shared conversation can be prompted by anyone who can see it, so acting as its
owner there would let any viewer act as that owner. A private one admits only its
owner, but it may still hold text someone else wrote: a webhook event, or a message
from while it was shared. Any author other than the owner taints the conversation's
tree, and a tainted conversation acts as nobody. Every per-user secret a sandbox
reaches is opened under `OwnerResolver.grant`, which fails closed: an unknown
conversation, a failed lookup, a shared conversation or a view without its authors
all resolve to None.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import httpx

from scooter_lib.logging_config import format_error

from .autolink import router_headers
from .types import Identity
from .user_secrets import UserGrant, _mint

logger = logging.getLogger(__name__)

# Short, because a conversation turned shared must stop using personal credentials quickly.
DEFAULT_TTL_SECONDS = 10.0

# Tells the agent it may ask the owner to untaint.
TAINTED_HINT = (
    "conversation_status names who else wrote text here; call request_untaint to ask the owner "
    "to vouch for it, rather than asking in chat."
)

# Fetches one conversation's agent-host view, None when it does not exist.
ConversationFetcher = Callable[[str], Awaitable["dict[str, Any] | None"]]


@dataclass(frozen=True)
class ConversationAccess:
    """The facts that decide whether a conversation acts as a person."""

    owner: str | None
    visibility: str
    # The Scooter user each author is, None for one who is nobody known; None when unknown.
    author_users: tuple[str | None, ...] | None = None

    @property
    def tainted(self) -> bool:
        return self.author_users is None or any(u != self.owner for u in self.author_users)

    @property
    def acting_user(self) -> str | None:
        if self.visibility != "private" or not self.owner or self.tainted:
            return None
        return self.owner


def _author_users(view: dict[str, Any]) -> tuple[str | None, ...] | None:
    """Each author's user from a view's `authors`, None when absent or malformed."""
    authors = view.get("authors")
    if not isinstance(authors, list) or not all(isinstance(a, dict) for a in authors):
        return None
    return tuple(a.get("user") if isinstance(a.get("user"), str) else None for a in authors)


def agent_host_fetcher(agent_host_url: str, *, timeout: float = 10.0, transport: httpx.AsyncBaseTransport | None = None) -> ConversationFetcher:
    """A fetcher reading GET /conversations/{id} from the agent-host (or the router in front of it)."""

    async def fetch(conversation_id: str) -> dict[str, Any] | None:
        async with httpx.AsyncClient(
            base_url=agent_host_url.rstrip("/"), timeout=timeout, headers=router_headers(), transport=transport
        ) as client:
            resp = await client.get(f"/conversations/{conversation_id}")
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()

    return fetch


@dataclass
class OwnerResolver:
    """Resolves a caller's conversation to its owner and visibility, cached for `ttl` seconds."""

    fetch: ConversationFetcher
    ttl: float = DEFAULT_TTL_SECONDS
    clock: Callable[[], float] = time.monotonic
    _cache: dict[str, tuple[float, ConversationAccess | None]] = field(default_factory=dict, repr=False)

    async def access(self, conversation_id: str) -> ConversationAccess | None:
        """The conversation's owner and visibility, None when unknown or unreadable."""
        if not conversation_id:
            return None
        now = self.clock()
        hit = self._cache.get(conversation_id)
        if hit is not None and now - hit[0] < self.ttl:
            return hit[1]
        try:
            view = await self.fetch(conversation_id)
        except (httpx.HTTPError, ValueError) as e:
            # Not cached, so the next request retries instead of staying impersonal for a TTL.
            logger.warning(
                "conversation lookup failed; acting as nobody",
                extra={"conversation_id": conversation_id, "error": format_error(e)},
            )
            return None
        access = (
            ConversationAccess(
                owner=view.get("owner") or None,
                visibility=view.get("visibility") or "shared",
                author_users=_author_users(view),
            )
            if view
            else None
        )
        self._cache[conversation_id] = (now, access)
        return access

    async def acting_user(self, identity: Identity) -> str | None:
        """The user whose personal credentials this caller may use: an untainted private conversation's owner, else None."""
        # The visibility is not in any token, so even an owner-bearing identity is looked up.
        access = await self.access(identity.conversation_id)
        return access.acting_user if access else None

    async def grant(self, identity: Identity) -> UserGrant | None:
        """Access to the acting user's secrets, None wherever `acting_user` is None."""
        user = await self.acting_user(identity)
        return _mint(user, "private-conversation") if user else None
