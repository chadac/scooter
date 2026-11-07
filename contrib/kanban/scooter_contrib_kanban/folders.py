"""Board folders: kanban owns them as locked folders in the user's sidebar.

The broker is a folder service, so the router lets it create, rename and delete a
locked folder for the user it names; the user can only file conversations in and out.
"""

from __future__ import annotations

import os
from typing import Protocol

import httpx

from scooter_lib.svcauth import TokenSource


class FolderError(Exception):
    """The router refused a folder call; `status` is its HTTP status."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


class Folders(Protocol):
    async def create(self, owner: str, name: str) -> str: ...
    async def rename(self, owner: str, folder: str, name: str) -> None: ...
    async def delete(self, owner: str, folder: str) -> None: ...


class RouterFolders:
    """The router's /folders routes, called as the broker on the user's behalf."""

    def __init__(
        self,
        base_url: str | None = None,
        token_path: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("AGENT_HOST_URL", "")).rstrip("/")
        self.token = TokenSource(
            token_path or os.environ.get("SCOOTER_ROUTER_TOKEN_PATH", "/var/run/secrets/scooter-router/token")
        )
        self.transport = transport

    async def _call(self, owner: str, method: str, path: str, body: dict | None = None) -> httpx.Response:
        if not self.base_url:
            raise FolderError(503, "AGENT_HOST_URL is not set")
        try:
            headers = self.token.headers(user=owner)
        except OSError:
            raise FolderError(503, "no router token") from None
        async with httpx.AsyncClient(timeout=10, transport=self.transport) as client:
            try:
                res = await client.request(method, f"{self.base_url}/folders{path}", json=body, headers=headers)
            except httpx.HTTPError as e:
                raise FolderError(502, f"router unreachable: {type(e).__name__}") from None
        if res.status_code >= 400:
            try:
                detail = str(res.json().get("error") or res.text)
            except ValueError:
                detail = res.text
            raise FolderError(res.status_code, detail)
        return res

    async def create(self, owner: str, name: str) -> str:
        res = await self._call(owner, "POST", "", {"name": name, "locked": True})
        return str(res.json()["id"])

    async def rename(self, owner: str, folder: str, name: str) -> None:
        await self._call(owner, "PATCH", f"/{folder}", {"name": name})

    async def delete(self, owner: str, folder: str) -> None:
        await self._call(owner, "DELETE", f"/{folder}")
