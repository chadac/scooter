"""mcpservers' HTTP routes, mounted under /mcpservers/*.

    GET    /user/servers         the caller's servers
    POST   /user/servers         {name, kind, spec, args?, enabled?}
    PATCH  /user/servers/{id}    {name?, kind?, spec?, args?, enabled?}
    DELETE /user/servers/{id}
    GET    /servers              the conversation owner's enabled servers, for its sandbox
    POST   /servers/status       {servers: [{name, state}], error?}, from that sandbox
    GET    /conversation/{id}/servers   the owner's servers with their last reported state

The /user/* and /conversation/* routes are reached only through the /contrib-api relay,
which names the user (scooter_broker_lib.user.user_identity); /user/* queries are scoped
to that user, and the relay has checked they may see the conversation.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from fastapi import APIRouter, Body, Depends, HTTPException

from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport
from scooter_broker_lib.user import user_identity

from .store import MAX_SERVERS, InvalidServer, McpServerStore, parse_args, valid_name

# `systemctl is-active` words: active, failed, activating...
_STATE = re.compile(r"^[a-z-]{1,16}$")
MAX_ERROR_LEN = 300


def parse_report(body: object) -> dict:
    """A sandbox's status report, or HTTPException 400."""
    servers = body.get("servers") if isinstance(body, dict) else None
    error = body.get("error") if isinstance(body, dict) else None
    ok = (
        isinstance(servers, list)
        and len(servers) <= MAX_SERVERS
        and all(
            isinstance(x, dict) and valid_name(x.get("name")) and isinstance(x.get("state"), str)
            and _STATE.match(x["state"])
            for x in servers
        )
        and (error is None or isinstance(error, str))
    )
    if not ok:
        raise HTTPException(status_code=400, detail="expected {servers: [{name, state}], error?}")
    return {
        "servers": [{"name": x["name"], "state": x["state"]} for x in servers],
        "error": error[:MAX_ERROR_LEN] if error else None,
    }


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

        @router.post("/servers/status")
        async def report_status(body: dict = Body(...), identity: Identity = Depends(authed)) -> dict:
            if not identity.conversation_id or identity.relayed_user:
                raise HTTPException(status_code=403, detail="only a sandbox reports its servers")
            await self._store().save_status(identity.conversation_id, parse_report(body))
            return {"ok": True}

        @router.get("/conversation/{conversation_id}/servers")
        async def conversation_servers(conversation_id: str, _user: str = user) -> dict:
            access = await self.owners.access(conversation_id) if self.owners else None
            if access is None or not access.owner:
                return {"servers": [], "reported_at": None, "error": None}
            last = await self._store().status(conversation_id)
            report, reported_at = last if last else ({"servers": [], "error": None}, None)
            states = {x["name"]: x["state"] for x in report["servers"]}
            servers = [
                {
                    # No args: a viewer of a shared conversation may not see them.
                    "name": srv.name, "kind": srv.kind, "spec": srv.spec, "enabled": srv.enabled,
                    "state": states.get(srv.name) if srv.enabled else None,
                    "tool_prefix": f"mcp__sandbox-{srv.name}__",
                }
                for srv in await self._store().list(access.owner)
            ]
            return {"servers": servers, "reported_at": reported_at, "error": report["error"]}

        return router
