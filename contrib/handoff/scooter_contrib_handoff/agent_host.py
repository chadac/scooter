"""The router, which owns conversations: list, read, spawn and link them.

The broker calls AGENT_HOST_URL (the router) with its router token and no user, so it
sees shared conversations only; a private one answers 404. The owned routes reach a
private source conversation's owner's own conversations, private ones included.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx
from scooter_broker_lib.autolink import router_headers
from scooter_lib.svcauth import USER_HEADER


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

    async def owned(self, source_id: str) -> list[dict[str, Any]]:
        """The list rows of every conversation the source's owner owns; [] when not enabled."""
        async with self._client() as c:
            r = await c.get(f"/conversations/{source_id}/owned")
        if r.status_code == 404:
            return []
        r.raise_for_status()
        return r.json()

    async def owned_messages(
        self, source_id: str, conversation_id: str, *, before: int, limit: int,
    ) -> dict[str, Any] | None:
        """Like messages, for a conversation the source's owner owns; None when not theirs."""
        async with self._client() as c:
            r = await c.get(
                f"/conversations/{source_id}/owned/{conversation_id}/messages",
                params={"before": before, "limit": limit},
            )
        if r.status_code == 404:
            return None
        r.raise_for_status()
        return r.json()

    async def has_folder(self, owner: str, folder: str) -> bool:
        """True when `folder` is one of `owner`'s folders."""
        async with self._client() as c:
            r = await c.get("/folders", headers={USER_HEADER: owner})
        r.raise_for_status()
        return any(f.get("id") == folder for f in r.json().get("folders") or [])

    async def file(self, owner: str, conversation_id: str, folder: str) -> None:
        """File `owner`'s conversation in their folder, as the broker's folder service."""
        async with self._client() as c:
            r = await c.put(
                f"/conversations/{quote(conversation_id, safe='')}/folder",
                json={"folderId": folder}, headers={USER_HEADER: owner},
            )
        r.raise_for_status()

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
