"""commits' HTTP routes, mounted under /commits/*.

    GET    /user/identity                     the caller's commit identity, or {"identity": null}
    PUT    /user/identity                     {name, email}: set or replace it, withdrawing proposals
    DELETE /user/identity                     clear it, so commits fall back to the forge account

/user/* is reached only through the /contrib-api relay, which names the user
(scooter_broker_lib.user.user_identity). Agents propose through mcp_tools.py, and
the user answers at /commits/approvals (./approvals.py).
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, Body, Depends, HTTPException

from scooter_broker_lib.approvals import Approvals
from scooter_broker_lib.types import AuthDependency, Provider
from scooter_broker_lib.user import user_identity

from .approvals import Proposed, withdraw_pending
from .store import CommitIdentityStore, InvalidIdentity, validated


@dataclass
class Commits:
    store: CommitIdentityStore | None = None
    proposals: Approvals[Proposed] | None = None
    name: str = "commits"

    def _ready(self) -> CommitIdentityStore:
        if self.store is None:
            raise HTTPException(status_code=503, detail="commits is not configured")
        return self.store

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        user = user_identity(authed)

        @router.get("/user/identity")
        async def get_identity(user_id: str = Depends(user)) -> dict:
            chosen = await self._ready().get(user_id)
            return {"identity": chosen.payload() if chosen else None}

        @router.put("/user/identity")
        async def set_identity(body: dict = Body(...), user_id: str = Depends(user)) -> dict:
            try:
                person = validated(body.get("name", ""), body.get("email", ""))
            except InvalidIdentity as e:
                raise HTTPException(status_code=400, detail=str(e)) from None
            chosen = await self._ready().set(user_id, person)
            if self.proposals is not None:
                await withdraw_pending(self.proposals, user_id)
            return {"identity": chosen.payload()}

        @router.delete("/user/identity")
        async def clear_identity(user_id: str = Depends(user)) -> dict:
            await self._ready().clear(user_id)
            return {"identity": None}

        return router
