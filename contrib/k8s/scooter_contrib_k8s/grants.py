"""Write and Secret grants as the Approvals tab lists them, and the verbs that change them.

Whoever could approve a grant's original request may extend, pin, revive or revoke it.
"""

from __future__ import annotations

from scooter_broker_lib.approvals import Approvals, Approver
from scooter_broker_lib.grants import (
    ACTIVE, EXPIRED, EXTEND, PIN, REVIVE, REVOKE, REVOKED, GrantChange, GrantError, GrantVerb, GrantView,
)

from .approvals import Op, may_approve
from .config import ClusterConfig
from .service import iso
from .store import Grant, GrantStore, _now_ms

PRESETS = (15, 30, 60, 240, 480, 1440)


def _when(g: Grant) -> str:
    return f"until {iso(g.expires_at)}" if g.expires_at is not None else "until revoked"


class K8sGrants:
    def __init__(self, store: GrantStore, approvals: Approvals[Op], clusters: dict[str, ClusterConfig]) -> None:
        self.store = store
        self.approvals = approvals
        self.clusters = clusters

    def _renewable(self, g: Grant) -> list[int]:
        """Durations a grant may get now; [] where its cluster no longer allows grants."""
        c = self.clusters.get(g.cluster)
        if c is None or c.read_only or not c.grants_enabled:
            return []
        return [m for m in PRESETS if m <= c.grant_max_minutes] or [c.grant_max_minutes]

    def view(self, g: Grant) -> GrantView:
        now = _now_ms()
        presets = self._renewable(g)
        if g.active(now):
            status = ACTIVE
            verbs = [GrantVerb(REVOKE, "Revoke")]
            if presets and g.expires_at is not None:
                verbs = [GrantVerb(EXTEND, "Extend", presets), GrantVerb(PIN, "Indefinite"), *verbs]
        else:
            status = REVOKED if g.revoked_at is not None else EXPIRED
            verbs = [GrantVerb(REVIVE, "Revive", presets)] if presets else []
        if g.kind == "secret":
            title = f"Read Secrets in {g.cluster}/{g.namespace}"
            scope = [f"cluster {g.cluster}", f"namespace {g.namespace}", f"Secrets: {', '.join(g.names)}"]
        else:
            title = f"Write to {g.cluster}/{g.namespace}"
            scope = [f"cluster {g.cluster}", f"namespace {g.namespace}", "apply, delete, scale, rollout restart"]
        return GrantView(
            id=g.id, conversation_id=g.conversation_id, title=title, scope=scope, status=status,
            granted_by=g.approved_by, granted_at=g.created_at, expires_at=g.expires_at, verbs=verbs,
            parent_id=g.parent_id, ended_at=g.revoked_at, ended_by=g.revoked_by,
        )

    def _what(self, g: Grant) -> str:
        if g.kind == "secret":
            return f"Secret grant ({', '.join(g.names)} in {g.cluster}/{g.namespace})"
        return f"write grant on {g.cluster}/{g.namespace}"

    async def list(self, conversation_id: str) -> list[GrantView]:
        return [self.view(g) for g in await self.store.all(conversation_id)]

    async def get(self, grant_id: str) -> GrantView | None:
        g = await self.store.get(grant_id)
        return self.view(g) if g else None

    async def may_act(self, grant: GrantView, verb: str, who: Approver) -> bool:
        g = await self.store.get(grant.id)
        req = await self.approvals.get(g.request_id) if g else None
        return req is not None and may_approve(req, who)

    async def act(self, grant: GrantView, verb: str, who: Approver, minutes: int | None) -> GrantChange:
        g = await self.store.get(grant.id)
        if g is None:
            raise GrantError("no such grant", 404)
        if verb == REVOKE:
            done = await self.store.revoke(g.id, who.id)
            if done is None:
                raise GrantError("the grant already ended", 409)
            return GrantChange(self.view(done), f"The user revoked your {self._what(g)}; ask again if you still need it.")
        if verb == REVIVE:
            new = await self.store.add(g.conversation_id, g.cluster, g.namespace, minutes=minutes or 0,
                                       approved_by=who.id, request_id=g.request_id, kind=g.kind, names=g.names,
                                       parent_id=g.id)
            return GrantChange(self.view(new), f"The user renewed your {self._what(g)}: it is active {_when(new)}.")
        until = None if verb == PIN else max(g.expires_at or 0, _now_ms()) + (minutes or 0) * 60_000
        done = await self.store.set_expiry(g.id, until)
        if done is None:
            raise GrantError("the grant already ended; revive it instead", 409)
        return GrantChange(self.view(done), f"The user extended your {self._what(g)}: it is active {_when(done)}.")

    async def revoke_conversation(self, conversation_id: str) -> int:
        return await self.store.revoke_conversation(conversation_id, "conversation deleted")
