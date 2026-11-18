"""Time-boxed workspace access: the first call to a workspace asks the owner, in the conversation.

A request with no live grant is refused with a reason the agent reads, and raises one
approval card per (conversation, workspace, level). Approving stores a grant for
`minutes`; `read-write` covers reads. Reads are GET/HEAD, so running SQL needs
read-write even for a SELECT. The Approvals tab lists the grants, to extend, pin,
revive or revoke.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from scooter_broker_lib.approvals import ApprovalRequest, Approvals, Approver, Card, Decision, TooManyPending
from scooter_broker_lib.forge.policy import Decision as PolicyDecision
from scooter_broker_lib.forge.policy import ForgeRequest
from scooter_broker_lib.grants import (
    ACTIVE, EXPIRED, EXTEND, PIN, REVIVE, REVOKE, REVOKED, GrantChange, GrantError, GrantVerb, GrantView,
)

from .store import READ, WRITE, Grant, GrantStore, now_ms

KIND = "databricks.grant"
PRESETS = (15, 30, 60, 240, 480, 1440)


@dataclass(frozen=True)
class Ask:
    workspace: str
    level: str
    method: str = ""
    path: str = ""


def level_of(method: str) -> str:
    return READ if method.upper() in {"GET", "HEAD"} else WRITE


def _when(g: Grant) -> str:
    if g.expires_at is None:
        return "until revoked"
    return "until " + datetime.fromtimestamp(g.expires_at / 1000, timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def _what(g: Grant | Ask) -> str:
    return f"{g.level} access to Databricks {g.workspace}"


def grant_approvals(store: GrantStore, minutes: int) -> Approvals[Ask]:
    def card(req: ApprovalRequest[Ask]) -> Card:
        a = req.payload
        what = "read (GET only)" if a.level == READ else "read-write (anything, including SQL and job runs)"
        return Card(
            message=(f"Allow this conversation {what} access to Databricks `{a.workspace}` for {minutes / 60:g} hours?"
                     + (f"\n\nIt tried: `{a.method} {a.path}`" if a.path else "")),
            data={"workspace": a.workspace, "level": a.level, "method": a.method, "path": a.path},
        )

    approvals = Approvals(contrib="databricks", kind=KIND, payload=Ask, render=card, max_pending=6)

    @approvals.on("approve")
    async def approve(req: ApprovalRequest[Ask], who: Approver) -> Decision:
        a = req.payload
        g = await store.add(req.conversation_id, a.workspace, a.level, minutes=minutes,
                            approved_by=who.id, request_id=req.id)
        return Decision(f"The user allowed {_what(g)} {_when(g)}. Retry the call that was refused.",
                        body={"grant_id": g.id})

    @approvals.on("deny")
    async def deny(req: ApprovalRequest[Ask], who: Approver) -> Decision:
        return Decision(f"The user denied {_what(req.payload)}. Don't retry it.")

    return approvals


@dataclass
class GrantPolicy:
    """The forge policy on one workspace's provider: allow under a live grant, else ask the owner."""

    workspace: str
    store: GrantStore
    approvals: Approvals[Ask]
    owners: Any

    async def check(self, request: ForgeRequest) -> PolicyDecision:
        cid = request.identity.conversation_id
        if not cid:
            return PolicyDecision.deny("no conversation to hold a grant")
        level = level_of(request.method)
        if await self.store.allows(cid, self.workspace, level):
            return PolicyDecision.allow(f"{level} grant")
        pending = await self.approvals.pending(conversation_id=cid)
        if not any(p.payload.workspace == self.workspace and p.payload.level == level for p in pending):
            access = await self.owners.access(cid) if self.owners else None
            owner = access.owner if access else None
            if not owner:
                return PolicyDecision.deny("this conversation has no owner to ask for Databricks access")
            try:
                await self.approvals.request(cid, Ask(self.workspace, level, request.method.upper(), request.path),
                                             owner=owner)
            except TooManyPending as e:
                return PolicyDecision.deny(str(e))
        return PolicyDecision.deny(
            f"waiting for the user to allow {level} access to Databricks {self.workspace} "
            "(a card is in their Approvals). Stop, tell the user you're waiting, and retry once they approve."
        )


class DatabricksGrants:
    """The grants as the Approvals tab lists them; whoever could approve one may change it."""

    def __init__(self, store: GrantStore, approvals: Approvals[Ask], max_minutes: int) -> None:
        self.store = store
        self.approvals = approvals
        self.presets = [m for m in PRESETS if m <= max_minutes] or [max_minutes]

    def view(self, g: Grant) -> GrantView:
        if g.active():
            status = ACTIVE
            verbs = [GrantVerb(REVOKE, "Revoke")]
            if g.expires_at is not None:
                verbs = [GrantVerb(EXTEND, "Extend", self.presets), GrantVerb(PIN, "Indefinite"), *verbs]
        else:
            status = REVOKED if g.revoked_at is not None else EXPIRED
            verbs = [GrantVerb(REVIVE, "Revive", self.presets)]
        scope = ["GET and HEAD"] if g.level == READ else ["any method, including SQL and job runs"]
        return GrantView(
            id=g.id, conversation_id=g.conversation_id, title=f"{g.level.capitalize()} {g.workspace}",
            scope=[f"workspace {g.workspace}", *scope], status=status, granted_by=g.approved_by,
            granted_at=g.created_at, expires_at=g.expires_at, verbs=verbs, parent_id=g.parent_id,
            ended_at=g.revoked_at, ended_by=g.revoked_by,
        )

    async def list(self, conversation_id: str) -> list[GrantView]:
        return [self.view(g) for g in await self.store.all(conversation_id)]

    async def get(self, grant_id: str) -> GrantView | None:
        g = await self.store.get(grant_id)
        return self.view(g) if g else None

    async def may_act(self, grant: GrantView, verb: str, who: Approver) -> bool:
        g = await self.store.get(grant.id)
        req = await self.approvals.get(g.request_id) if g else None
        return req is not None and self.approvals.may_approve(req, who)

    async def act(self, grant: GrantView, verb: str, who: Approver, minutes: int | None) -> GrantChange:
        g = await self.store.get(grant.id)
        if g is None:
            raise GrantError("no such grant", 404)
        if verb == REVOKE:
            done = await self.store.revoke(g.id, who.id)
            if done is None:
                raise GrantError("the grant already ended", 409)
            return GrantChange(self.view(done), f"The user revoked your {_what(g)}; ask again if you still need it.")
        if verb == REVIVE:
            new = await self.store.add(g.conversation_id, g.workspace, g.level, minutes=minutes or 0,
                                       approved_by=who.id, request_id=g.request_id, parent_id=g.id)
            return GrantChange(self.view(new), f"The user renewed your {_what(g)}: it is active {_when(new)}.")
        until = None if verb == PIN else max(g.expires_at or 0, now_ms()) + (minutes or 0) * 60_000
        done = await self.store.set_expiry(g.id, until)
        if done is None:
            raise GrantError("the grant already ended; revive it instead", 409)
        return GrantChange(self.view(done), f"The user extended your {_what(g)}: it is active {_when(done)}.")

    async def revoke_conversation(self, conversation_id: str) -> int:
        return await self.store.revoke_conversation(conversation_id, "conversation deleted")
