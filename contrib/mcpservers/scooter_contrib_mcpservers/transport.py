"""mcpservers' HTTP routes, mounted under /mcpservers/*.

    GET    /user/servers         the caller's servers
    POST   /user/servers         {name, kind, spec, args?, enabled?}
    PATCH  /user/servers/{id}    {name?, kind?, spec?, args?, enabled?}
    DELETE /user/servers/{id}
    GET    /servers              the conversation owner's enabled servers, for its sandbox

The /user/* routes are reached only through the /contrib-api relay, which names the
user (scooter_broker_lib.user.user_identity); every query is scoped to that user.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable

from fastapi import APIRouter, Body, Depends, HTTPException

from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport
from scooter_broker_lib.user import user_identity

from .store import InvalidServer, McpServerStore, parse_args


@dataclass
class McpServers(Transport):
    name: str = "mcpservers"
    store: McpServerStore | None = field(default=None)
    owners: OwnerResolver | None = None
    # The relayed user; None means user_identity(authed). Tests may inject a fake.
    user: Callable[..., Awaitable[str]] | None = None

    def _store(self) -> McpServerStore:
        if self.store is None:
            raise HTTPException(status_code=503, detail="MCP servers are not configured")
        return self.store

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter(tags=["mcpservers"])
        user = Depends(self.user or user_identity(authed))

        def invalid(e: InvalidServer) -> HTTPException:
            return HTTPException(status_code=400, detail=str(e))

        @router.get("/user/servers")
        async def list_servers(owner: str = user) -> dict:
            return {"servers": [s.payload() for s in await self._store().list(owner)]}

        @router.post("/user/servers")
        async def add_server(body: dict = Body(...), owner: str = user) -> dict:
            try:
                srv = await self._store().create(
                    owner,
                    name=str(body.get("name", "")),
                    kind=str(body.get("kind", "")),
                    spec=str(body.get("spec", "")),
                    args=parse_args(body.get("args")),
                    enabled=body.get("enabled", True) is not False,
                )
            except InvalidServer as e:
                raise invalid(e) from e
            return {"server": srv.payload()}

        @router.patch("/user/servers/{server_id}")
        async def patch_server(server_id: str, body: dict = Body(...), owner: str = user) -> dict:
            fields: dict = {}
            for key in ("name", "kind", "spec"):
                if key in body:
                    fields[key] = str(body[key])
            if "enabled" in body:
                if not isinstance(body["enabled"], bool):
                    raise HTTPException(status_code=400, detail="enabled must be a boolean")
                fields["enabled"] = body["enabled"]
            try:
                if "args" in body:
                    fields["args"] = parse_args(body["args"])
                srv = await self._store().update(owner, server_id, **fields)
            except InvalidServer as e:
                raise invalid(e) from e
            if srv is None:
                raise HTTPException(status_code=404, detail="no such server")
            return {"server": srv.payload()}

        @router.delete("/user/servers/{server_id}")
        async def delete_server(server_id: str, owner: str = user) -> dict:
            if not await self._store().delete(owner, server_id):
                raise HTTPException(status_code=404, detail="no such server")
            return {"deleted": server_id}

        @router.get("/servers")
        async def sandbox_servers(identity: Identity = Depends(authed)) -> dict:
            # A shared conversation runs its owner's servers.
            access = await self.owners.access(identity.conversation_id) if self.owners else None
            if access is None or not access.owner:
                return {"servers": []}
            enabled = await self._store().list(access.owner, enabled_only=True)
            return {"servers": [s.sandbox_payload() for s in enabled]}

        return router
