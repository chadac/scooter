"""The router, which owns conversations: list, read, spawn and link them.

The broker calls AGENT_HOST_URL (the router) with its router token and no user, so it
sees shared conversations only; a private one answers 404.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx
from scooter_broker_lib.autolink import router_headers


class SpawnError(Exception):
    """The router refused or failed a spawn; `conversation_id` is set if one was created."""

    def __init__(self, message: str, conversation_id: str | None = None) -> None:
        super().__init__(message)
        self.conversation_id = conversation_id


@dataclass
class AgentHost:
    url: str
    timeout: float = 20.0
    # For tests (httpx.MockTransport).
    transport: httpx.AsyncBaseTransport | None = None

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.url.rstrip("/"), timeout=self.timeout, headers=router_headers(), transport=self.transport
        )

    async def shared(self) -> list[dict[str, Any]]:
        """Every shared conversation's list row."""
        async with self._client() as c:
            r = await c.get("/conversations", params={"scope": "all"})
        r.raise_for_status()
        body = r.json()
        rows = body if isinstance(body, list) else body.get("conversations", [])
        return [row for row in rows if row.get("visibility", "shared") == "shared"]

    async def conversation(self, conversation_id: str) -> dict[str, Any] | None:
        """One shared conversation's view; None when unknown or private."""
        async with self._client() as c:
            r = await c.get(f"/conversations/{conversation_id}")
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    async def messages(self, conversation_id: str, *, before: int, limit: int) -> dict[str, Any] | None:
        """The folded page before seq `before`; None when unknown or private."""
        async with self._client() as c:
            r = await c.get(f"/conversations/{conversation_id}/messages", params={"before": before, "limit": limit})
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    async def spawn(self, source_id: str, *, prompt: str, title: str, model: str, source: str) -> dict[str, Any]:
        """Open a conversation for the source's owner; raises SpawnError with the router's reason."""
        body = {"prompt": prompt, "title": title, "model": model, "source": source}
        async with self._client() as c:
            r = await c.post(f"/conversations/{source_id}/spawns", json=body)
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code == 201:
            return data
        if r.status_code == 404:
            raise SpawnError("spawning is not enabled here, or this conversation is unknown to the router")
        raise SpawnError(f"HTTP {r.status_code}: {data.get('error') or r.text}", data.get("id"))
