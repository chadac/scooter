"""handoff's HTTP routes, mounted under /handoff/*.

    POST   /system/index                 one search-index pass (the index system task only)
    GET    /spawns/pending               ?conversation_id=: pending handoffs' approval cards
    POST   /spawns/{id}/can-approve      {approver}: whether this person may answer
    POST   /spawns/{id}/approve          {approver}: spawn it, and tell the agent
    POST   /spawns/{id}/deny             {approver}: drop it, and tell the agent

/spawns/* is the agent-host's approval relay (scooter.approvals.handoff), so it
takes approver callers only, and only the conversation's owner may answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable

from fastapi import APIRouter, Body, Depends, HTTPException

from scooter_broker_lib.system import system_task_identity
from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport

from .agent_host import AgentHost
from .host import card
from .index import reindex
from .spawn import SpawnFailed, Spawner
from .store import HandoffStore, NotYours, Refused, SpawnRequest


def _approver(body: dict) -> str:
    """The answering user's id, as the agent-host sends it."""
    a = body.get("approver")
    who = a.get("id") if isinstance(a, dict) else a
    if not isinstance(who, str) or not who:
        raise HTTPException(status_code=400, detail="approver required")
    return who


def _label(r: SpawnRequest) -> str:
    return f'"{r.title}"' if r.title else "request"


@dataclass
class Handoff(Transport):
    name: str = "handoff"
    store: HandoffStore | None = field(default=None)
    agent_host: AgentHost | None = field(default=None)
    spawner: Spawner | None = field(default=None)
    # None means system_task_identity(authed); tests inject a fake.
    system: Callable[..., Awaitable[object]] | None = None

    def _ready(self) -> HandoffStore:
        if self.store is None:
            raise HTTPException(status_code=503, detail="handoff not configured")
        return self.store

    async def _decide(self, request_id: str, body: dict, status: str) -> SpawnRequest:
        try:
            return await self._ready().decide_spawn(request_id, _approver(body), status)
        except NotYours as e:
            raise HTTPException(status_code=403, detail={"errors": [str(e)]}) from None

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter(tags=["handoff"])
        system = Depends(self.system or system_task_identity(authed))

        async def approver_caller(identity: Identity = Depends(authed)) -> Identity:
            if not identity.is_approver:
                raise HTTPException(status_code=403, detail="not an approver")
            return identity

        approver = [Depends(approver_caller)]

        @router.post("/system/index", dependencies=[system])
        async def index() -> dict:
            if self.agent_host is None:
                raise HTTPException(status_code=503, detail="AGENT_HOST_URL is not set")
            return await reindex(self._ready(), self.agent_host)

        @router.get("/spawns/pending", dependencies=approver)
        async def pending(conversation_id: str = "") -> dict:
            if not conversation_id:
                raise HTTPException(status_code=400, detail="conversation_id required")
            return {"requests": [card(r) for r in await self._ready().pending_spawns(conversation_id)]}

        @router.post("/spawns/{request_id}/can-approve", dependencies=approver)
        async def can_approve(request_id: str, body: dict = Body(default={})) -> dict:
            r = await self._ready().spawn_request(request_id)
            return {"can_approve": r is not None and r.status == "pending" and r.owner == _approver(body)}

        @router.post("/spawns/{request_id}/approve", dependencies=approver)
        async def approve(request_id: str, body: dict = Body(default={})) -> dict:
            if self.spawner is None:
                raise HTTPException(status_code=503, detail="AGENT_HOST_URL is not set")
            try:
                r = await self._decide(request_id, body, "approved")
            except Refused as e:
                return {"refused": str(e)}
            try:
                made = await self.spawner.spawn(r.conversation_id, brief=r.brief, title=r.title, model=r.model)
            except SpawnFailed as e:
                await self._ready().record_spawn(r.id, spawned_id=None, status="failed")
                return {"failed": str(e), "agent_message": f"The user approved your handoff {_label(r)}, but {e}"}
            await self._ready().record_spawn(r.id, spawned_id=made["conversation_id"], status="spawned")
            return {**made, "agent_message": (
                f"The user approved your handoff {_label(r)}. It started as conversation "
                f"{made['conversation_id']} ({made['url']}) with your brief as its first message."
            )}

        @router.post("/spawns/{request_id}/deny", dependencies=approver)
        async def deny(request_id: str, body: dict = Body(default={})) -> dict:
            try:
                r = await self._decide(request_id, body, "denied")
            except Refused as e:
                return {"refused": str(e)}
            return {"denied": r.id, "agent_message": f"The user denied your handoff {_label(r)}; no conversation was created."}

        return router
