"""The card key for an agent's conversation.

Cards are keyed by the sandbox key, which the board and the hooks (SA-token callers)
already use. An MCP caller is named by its thread id instead, so the tools look its
sandbox up on the agent-host, which answers for either form.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import httpx
from scooter_broker_lib.autolink import router_headers

logger = logging.getLogger(__name__)


def sandbox_key(sandbox_name: str) -> str:
    """Mirrors agent-host's sandboxKey: the Sandbox name without `conv-`."""
    return sandbox_name.removeprefix("conv-")


@dataclass
class CardKeys:
    agent_host_url: str
    timeout: float = 10.0
    # For tests (httpx.MockTransport).
    transport: httpx.AsyncBaseTransport | None = None
    # A conversation's sandbox never changes, so a hit is kept for good.
    _cache: dict[str, str] = field(default_factory=dict)

    async def key(self, conversation_id: str) -> str | None:
        """The conversation's card key, None when the agent-host does not know it."""
        if hit := self._cache.get(conversation_id):
            return hit
        async with httpx.AsyncClient(
            base_url=self.agent_host_url.rstrip("/"), timeout=self.timeout, headers=router_headers(), transport=self.transport
        ) as c:
            r = await c.get(f"/conversations/{conversation_id}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        name = (r.json().get("sandbox") or {}).get("name") or ""
        if not name:
            return None
        self._cache[conversation_id] = key = sandbox_key(name)
        return key
