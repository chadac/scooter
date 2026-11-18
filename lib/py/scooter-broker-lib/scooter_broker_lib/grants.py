"""Standing grants a contrib's approvals created: list them, and extend, pin, revive or revoke one.

A contrib keeps its grants in its own tables and implements `GrantSource` over them;
`Grants` mounts the routes the agent-host relays the user's clicks to:

    POST /grants/list                {approver, conversation_ids}: the grants, each verb
                                     marked with whether this approver may use it
    POST /grants/{id}/{verb}         {approver, conversation_ids, minutes?}: do it
    POST /grants/revoke-conversation {conversation_id}: end every grant, on deletion

`conversation_ids` are the keys the viewer's conversation goes by; a grant outside them
is a 404, so one conversation's page can't reach another's grants.
"""

from __future__ import annotations

import logging
from dataclasses import asdict, dataclass, field
from typing import Any, Protocol

from fastapi import APIRouter, Body, Depends, HTTPException

from .approvals import Approver, _approver
from .types import AuthDependency, Identity, Provider, Transport

logger = logging.getLogger(__name__)

ACTIVE = "active"
EXPIRED = "expired"
REVOKED = "revoked"

EXTEND = "extend"
PIN = "pin"
REVIVE = "revive"
REVOKE = "revoke"
VERBS = (EXTEND, PIN, REVIVE, REVOKE)
#: Verbs that take `minutes`.
TIMED = (EXTEND, REVIVE)


@dataclass(frozen=True)
class GrantVerb:
    verb: str
    label: str
    #: The durations offered, for extend and revive.
    presets_minutes: list[int] = field(default_factory=list)


@dataclass(frozen=True)
class GrantView:
    """One grant as the person reads it; the contrib renders every string."""

    id: str
    conversation_id: str
    title: str
    scope: list[str]
    status: str
    granted_by: str
    granted_at: int
    #: Epoch ms; None means until revoked.
    expires_at: int | None
    verbs: list[GrantVerb]
    #: The grant this one revived.
    parent_id: str | None = None
    #: When and by whom a revoked grant was ended.
    ended_at: int | None = None
    ended_by: str | None = None

    def wire(self) -> dict[str, Any]:
        out = asdict(self)
        del out["conversation_id"]
        return out


@dataclass(frozen=True)
class GrantChange:
    grant: GrantView
    #: Told to the agent, whose access just changed.
    agent_message: str | None = None


class GrantError(Exception):
    """A refused verb; `status` is the HTTP status the relay answers with."""

    def __init__(self, reason: str, status: int = 400) -> None:
        super().__init__(reason)
        self.status = status


class GrantSource(Protocol):
    async def list(self, conversation_id: str) -> list[GrantView]: ...

    async def get(self, grant_id: str) -> GrantView | None: ...

    async def may_act(self, grant: GrantView, verb: str, who: Approver) -> bool: ...

    async def act(self, grant: GrantView, verb: str, who: Approver, minutes: int | None) -> GrantChange: ...

    async def revoke_conversation(self, conversation_id: str) -> int: ...


def offers(grant: GrantView, verb: str) -> bool:
    return any(v.verb == verb for v in grant.verbs)


def _minutes(grant: GrantView, verb: str, body: dict) -> int | None:
    if verb not in TIMED:
        return None
    m = body.get("minutes")
    if not isinstance(m, int) or isinstance(m, bool) or m <= 0:
        raise HTTPException(status_code=400, detail={"errors": [f"{verb} needs a positive whole `minutes`"]})
    presets = next(v.presets_minutes for v in grant.verbs if v.verb == verb)
    if presets and m > max(presets):
        raise HTTPException(status_code=400, detail={"errors": [f"at most {max(presets)} minutes at a time"]})
    return m


def _keys(body: dict) -> list[str]:
    keys = body.get("conversation_ids")
    if not isinstance(keys, list) or not keys or not all(isinstance(k, str) and k for k in keys):
        raise HTTPException(status_code=400, detail={"errors": ["conversation_ids required"]})
    return keys


@dataclass
class Grants(Transport):
    contrib: str
    source: GrantSource
    name: str = "grants"

    async def _grant(self, grant_id: str, body: dict) -> GrantView:
        grant = await self.source.get(grant_id)
        if grant is None or grant.conversation_id not in _keys(body):
            raise HTTPException(status_code=404, detail={"errors": ["no such grant"]})
        return grant

    async def act(self, grant_id: str, verb: str, body: dict) -> dict[str, Any]:
        """Run `verb` on a grant as the body's approver, and log it for audit."""
        who = _approver(body)
        grant = await self._grant(grant_id, body)
        if verb not in VERBS or not offers(grant, verb):
            raise HTTPException(status_code=409, detail={"errors": [f"this grant can't {verb} now"]})
        minutes = _minutes(grant, verb, body)
        if not await self.source.may_act(grant, verb, who):
            raise HTTPException(status_code=403, detail={"errors": [f"{who.id} may not {verb} this grant"]})
        try:
            change = await self.source.act(grant, verb, who, minutes)
        except GrantError as e:
            raise HTTPException(status_code=e.status, detail={"errors": [str(e)]}) from None
        logger.info("grant changed", extra={
            "contrib": self.contrib, "grant_id": grant.id, "verb": verb, "approver": who.id,
            "conversation_id": grant.conversation_id, "new_grant_id": change.grant.id,
            "old_expires_at": grant.expires_at, "new_expires_at": change.grant.expires_at,
        })
        out: dict[str, Any] = {"grant": change.grant.wire()}
        if change.agent_message:
            out["agent_message"] = change.agent_message
        return out

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        async def approver_caller(identity: Identity = Depends(authed)) -> Identity:
            if not identity.is_approver:
                raise HTTPException(status_code=403, detail="not an approver")
            return identity

        router = APIRouter(prefix="/grants", tags=[f"{self.contrib} grants"],
                           dependencies=[Depends(approver_caller)])

        @router.post("/list")
        async def listing(body: dict = Body(default={})) -> dict:
            who = _approver(body)
            out = []
            for key in dict.fromkeys(_keys(body)):
                for g in await self.source.list(key):
                    view = g.wire()
                    for v in view["verbs"]:
                        v["allowed"] = await self.source.may_act(g, v["verb"], who)
                    out.append(view)
            return {"grants": out}

        @router.post("/revoke-conversation")
        async def revoke_conversation(body: dict = Body(default={})) -> dict:
            cid = body.get("conversation_id")
            if not isinstance(cid, str) or not cid:
                raise HTTPException(status_code=400, detail="conversation_id required")
            n = await self.source.revoke_conversation(cid)
            if n:
                logger.info("grants revoked with their conversation",
                            extra={"contrib": self.contrib, "conversation_id": cid, "revoked": n})
            return {"revoked": n}

        @router.post("/{grant_id}/{verb}")
        async def verb(grant_id: str, verb: str, body: dict = Body(default={})) -> dict:
            return await self.act(grant_id, verb, body)

        return router
