"""skills' HTTP routes, mounted under /skills/*.

    GET    /user/sources         the caller's sources
    POST   /user/sources         {kind, spec, skills?, enabled?}
    PATCH  /user/sources/{id}    {kind?, spec?, skills?, enabled?}
    DELETE /user/sources/{id}
    GET    /sources              the conversation owner's enabled sources, for its sandbox

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

from .store import InvalidSource, SkillSourceStore, parse_filter


@dataclass
class SkillSources(Transport):
    name: str = "skills"
    store: SkillSourceStore | None = field(default=None)
    owners: OwnerResolver | None = None
    # The relayed user; None means user_identity(authed). Tests may inject a fake.
    user: Callable[..., Awaitable[str]] | None = None

    def _store(self) -> SkillSourceStore:
        if self.store is None:
            raise HTTPException(status_code=503, detail="skill sources are not configured")
        return self.store

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter(tags=["skills"])
        user = Depends(self.user or user_identity(authed))

        def invalid(e: InvalidSource) -> HTTPException:
            return HTTPException(status_code=400, detail=str(e))

        @router.get("/user/sources")
        async def list_sources(owner: str = user) -> dict:
            return {"sources": [s.payload() for s in await self._store().list(owner)]}

        @router.post("/user/sources")
        async def add_source(body: dict = Body(...), owner: str = user) -> dict:
            try:
                src = await self._store().create(
                    owner,
                    kind=str(body.get("kind", "")),
                    spec=str(body.get("spec", "")),
                    skills=parse_filter(body.get("skills")),
                    enabled=body.get("enabled", True) is not False,
                )
            except InvalidSource as e:
                raise invalid(e) from e
            return {"source": src.payload()}

        @router.patch("/user/sources/{source_id}")
        async def patch_source(source_id: str, body: dict = Body(...), owner: str = user) -> dict:
            fields: dict = {}
            for key in ("kind", "spec"):
                if key in body:
                    fields[key] = str(body[key])
            if "skills" in body:
                fields["skills"] = parse_filter(body["skills"])
            if "enabled" in body:
                if not isinstance(body["enabled"], bool):
                    raise HTTPException(status_code=400, detail="enabled must be a boolean")
                fields["enabled"] = body["enabled"]
            try:
                src = await self._store().update(owner, source_id, **fields)
            except InvalidSource as e:
                raise invalid(e) from e
            if src is None:
                raise HTTPException(status_code=404, detail="no such source")
            return {"source": src.payload()}

        @router.delete("/user/sources/{source_id}")
        async def delete_source(source_id: str, owner: str = user) -> dict:
            if not await self._store().delete(owner, source_id):
                raise HTTPException(status_code=404, detail="no such source")
            return {"deleted": source_id}

        @router.get("/sources")
        async def sandbox_sources(identity: Identity = Depends(authed)) -> dict:
            # Like personal skills, a shared conversation still gets its owner's.
            access = await self.owners.access(identity.conversation_id) if self.owners else None
            if access is None or not access.owner:
                return {"sources": []}
            enabled = await self._store().list(access.owner, enabled_only=True)
            return {"sources": [s.sandbox_payload() for s in enabled]}

        return router
