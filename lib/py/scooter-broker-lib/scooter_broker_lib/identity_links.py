"""Which Scooter user a forge account is, written to the agent-host's `identities` table.

A user proves an account is theirs by linking it in Settings. The taint check then
counts that account's webhook messages as the user's own. Only the broker may call
these routes; agent-host checks its service account.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import quote

import httpx

from .autolink import router_headers


@dataclass
class IdentityLinks:
    """The agent-host's /identity-links routes, raising on any failure."""

    agent_host_url: str
    transport: httpx.AsyncBaseTransport | None = None

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.agent_host_url.rstrip("/"), timeout=10, headers=router_headers(), transport=self.transport
        )

    @staticmethod
    def _path(provider: str, user: str) -> str:
        return f"/identity-links/{quote(provider, safe='')}/{quote(user, safe='')}"

    async def link(self, provider: str, user: str, external_id: str, handle: str) -> None:
        async with self._client() as c:
            resp = await c.put(self._path(provider, user), json={"externalId": external_id, "handle": handle})
        resp.raise_for_status()

    async def unlink(self, provider: str, user: str) -> None:
        async with self._client() as c:
            resp = await c.delete(self._path(provider, user))
        resp.raise_for_status()
