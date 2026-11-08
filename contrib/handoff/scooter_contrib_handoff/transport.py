"""handoff's HTTP routes, mounted under /handoff/*.

    POST   /system/index                 one search-index pass (the index system task only)

Spawn approvals mount beside it at /handoff/approvals (./approvals.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException

from scooter_broker_lib.system import system_task_identity
from scooter_broker_lib.types import AuthDependency, Provider, Transport

from .agent_host import AgentHost
from .index import reindex
from .store import HandoffStore


@dataclass
class Handoff(Transport):
    name: str = "handoff"
    store: HandoffStore | None = field(default=None)
    agent_host: AgentHost | None = field(default=None)
    # None means system_task_identity(authed); tests inject a fake.
    system: Callable[..., Awaitable[object]] | None = None

    def _ready(self) -> HandoffStore:
        if self.store is None:
            raise HTTPException(status_code=503, detail="handoff not configured")
        return self.store

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter(tags=["handoff"])
        system = Depends(self.system or system_task_identity(authed))

        @router.post("/system/index", dependencies=[system])
        async def index() -> dict:
            if self.agent_host is None:
                raise HTTPException(status_code=503, detail="AGENT_HOST_URL is not set")
            return await reindex(self._ready(), self.agent_host)

        return router
