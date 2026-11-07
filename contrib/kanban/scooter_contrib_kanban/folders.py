"""Board and stage folders: kanban owns them as locked folders in the user's sidebar.

The broker is a folder service, so the router lets it create, rename, reorder and
delete a locked folder for the user it names, and file that user's conversations.
A board is a top-level locked folder and each stage a locked folder inside it; the
user can only file conversations in and out of them.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import quote

import httpx

from scooter_lib.svcauth import TokenSource

from .keys import sandbox_key


class FolderError(Exception):
    """The router refused a folder call; `status` is its HTTP status."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass(frozen=True)
class Conversation:
    """A conversation as the router knows it, looked up by its id or the broker's key."""

    id: str
    owner: str
    title: str = ""
    # The broker's key, which cards and blockers are stored by.
    key: str = ""


class Folders(Protocol):
    async def create(self, owner: str, name: str, parent: str = "") -> str: ...
    async def update(self, owner: str, folder: str, *, name: str | None = None, position: float | None = None) -> None: ...
    async def delete(self, owner: str, folder: str, *, subfolders: bool = False) -> None: ...
    async def conversation(self, key: str) -> Conversation | None: ...
    async def placement(self, owner: str, conversation: str) -> str | None: ...
    async def filed(self, owner: str) -> dict[str, str]: ...
    async def file(self, owner: str, conversation: str, folder: str) -> None: ...


class RouterFolders:
    """The router's /folders and placement routes, called as the broker on the user's behalf."""

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
                res = await client.request(method, f"{self.base_url}{path}", json=body, headers=headers)
            except httpx.HTTPError as e:
                raise FolderError(502, f"router unreachable: {type(e).__name__}") from None
        if res.status_code >= 400:
            try:
                detail = str(res.json().get("error") or res.text)
            except ValueError:
                detail = res.text
            raise FolderError(res.status_code, detail)
        return res

    async def create(self, owner: str, name: str, parent: str = "") -> str:
        body: dict = {"name": name, "locked": True}
        if parent:
            body["parentId"] = parent
        res = await self._call(owner, "POST", "/folders", body)
        return str(res.json()["id"])

    async def update(self, owner: str, folder: str, *, name: str | None = None, position: float | None = None) -> None:
        body = {k: v for k, v in (("name", name), ("position", position)) if v is not None}
        await self._call(owner, "PATCH", f"/folders/{folder}", body)

    async def delete(self, owner: str, folder: str, *, subfolders: bool = False) -> None:
        # Deleted stages' conversations move up to the board folder.
        await self._call(owner, "DELETE", f"/folders/{folder}" + ("?subfolders=delete" if subfolders else ""))

    async def conversation(self, key: str) -> Conversation | None:
        try:
            res = await self._call("", "GET", f"/conversations/{quote(key, safe='')}")
        except FolderError as e:
            if e.status == 404:
                return None
            raise
        view = res.json()
        if not view.get("id") or not view.get("owner"):
            return None
        sandbox = (view.get("sandbox") or {}).get("name") or ""
        return Conversation(
            id=str(view["id"]), owner=str(view["owner"]), title=str(view.get("title") or ""),
            key=sandbox_key(sandbox) if sandbox else key,
        )

    async def filed(self, owner: str) -> dict[str, str]:
        """Conversation id -> folder id, for every conversation `owner` has filed."""
        res = await self._call(owner, "GET", "/folders")
        return dict(res.json().get("placements") or {})

    async def placement(self, owner: str, conversation: str) -> str | None:
        return (await self.filed(owner)).get(conversation)

    async def file(self, owner: str, conversation: str, folder: str) -> None:
        await self._call(owner, "PUT", f"/conversations/{quote(conversation, safe='')}/folder", {"folderId": folder})
