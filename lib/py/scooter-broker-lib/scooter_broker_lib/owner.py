"""Whose personal credentials a request may use: the owner of a private conversation, else nobody.

A shared conversation can be prompted by anyone who can see it, so acting as its
owner there would let any viewer act as that owner. A private one admits only its
owner, so the agent in it acts for that one person. Every per-user credential goes
through `OwnerResolver.acting_user`, which fails closed: an unknown conversation, a
failed lookup or a shared conversation all resolve to None.
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

logger = logging.getLogger(__name__)

# Short, because a conversation turned shared must stop using personal credentials quickly.
DEFAULT_TTL_SECONDS = 10.0

# Fetches one conversation's agent-host view, None when it does not exist.
ConversationFetcher = Callable[[str], Awaitable["dict[str, Any] | None"]]


@dataclass(frozen=True)
class ConversationAccess:
    """The two facts that decide whether a conversation acts as a person."""

    owner: str | None
    visibility: str

    @property
    def acting_user(self) -> str | None:
        return self.owner if self.visibility == "private" and self.owner else None


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
            ConversationAccess(owner=view.get("owner") or None, visibility=view.get("visibility") or "shared")
            if view
            else None
        )
        self._cache[conversation_id] = (now, access)
        return access

    async def acting_user(self, identity: Identity) -> str | None:
        """The user whose personal credentials this caller may use: a private conversation's owner, else None."""
        # The visibility is not in any token, so even an owner-bearing identity is looked up.
        access = await self.access(identity.conversation_id)
        return access.acting_user if access else None
