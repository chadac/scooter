"""Generic ASYNC approval — the provider-agnostic pending-approval record + store.

When authorization yields REQUIRE_APPROVAL the middleware creates a PendingApproval
and returns 202 (it does NOT block); a human approves/denies out-of-band; the
caller retries and the middleware finds the approved record for its (conversation,
scope) and lets the call through. This matches AWS's async shape — the unifying
interaction model.

The store is provider-agnostic; a provider's approve-time side-effect (email:
none; AWS: mint STS) runs via an `on_approved` callback the store invokes. This
generic record is NOT the AWS PermissionRequest (which keeps its rich IAM/STS
store); it's the thin cross-provider approval handle.

See todo/docs/EXTENSIBLE_BROKER.md.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol, runtime_checkable


@dataclass
class PendingApproval:
    """One cross-provider approval in flight. `scope` + `summary` + `detail` are
    what the approval interrupt renders; `detail` is provider metadata (recipients,
    policy ARNs) — never a secret."""

    id: str
    conversation_id: str
    provider: str
    scope: str
    summary: str
    status: str = "pending"  # pending | approved | denied
    approver: str | None = None
    deny_reason: str | None = None
    detail: dict = field(default_factory=dict)


# A provider's approve-time side-effect. May be sync or async. Given the approved
# record; raising propagates to the approve caller (so a failed STS vend surfaces).
OnApproved = Callable[[PendingApproval], None] | Callable[[PendingApproval], Awaitable[None]]


@runtime_checkable
class ApprovalStore(Protocol):
    def create(self, *, conversation_id: str, provider: str, scope: str, summary: str, detail: dict) -> PendingApproval: ...
    def get(self, approval_id: str) -> PendingApproval | None: ...
    def find_approved(self, *, conversation_id: str, scope: str) -> PendingApproval | None: ...
    async def approve(self, approval_id: str, *, approver: str) -> PendingApproval: ...
    async def deny(self, approval_id: str, *, approver: str, reason: str | None = None) -> PendingApproval: ...


class InMemoryApprovalStore:
    """Default store. In-memory: an approval is short-lived (the agent retries
    within a turn), and the durable record — where one is needed — is the
    provider's own store (AWS keeps its PermissionStore). A deployer needing
    cross-replica/durable approvals plugs in their own ApprovalStore."""

    def __init__(self) -> None:
        self._by_id: dict[str, PendingApproval] = {}
        self._on_approved: OnApproved | None = None

    def set_on_approved(self, cb: OnApproved | None) -> None:
        """Register the approve-time side-effect (provider-agnostic; the app wires
        the mounting provider's on_approved here per record via the callback)."""
        self._on_approved = cb

    def create(self, *, conversation_id: str, provider: str, scope: str, summary: str, detail: dict) -> PendingApproval:
        rec = PendingApproval(
            id=uuid.uuid4().hex[:12],
            conversation_id=conversation_id,
            provider=provider,
            scope=scope,
            summary=summary,
            detail=detail or {},
        )
        self._by_id[rec.id] = rec
        return rec

    def get(self, approval_id: str) -> PendingApproval | None:
        return self._by_id.get(approval_id)

    def find_approved(self, *, conversation_id: str, scope: str) -> PendingApproval | None:
        """An approved record matching this caller + scope satisfies the gate on a
        retry. Consumed-once semantics are the caller's concern; here we just find
        the newest approved match."""
        for rec in self._by_id.values():
            if rec.status == "approved" and rec.conversation_id == conversation_id and rec.scope == scope:
                return rec
        return None

    async def approve(self, approval_id: str, *, approver: str) -> PendingApproval:
        rec = self._require(approval_id)
        rec.status = "approved"
        rec.approver = approver
        if self._on_approved is not None:
            res = self._on_approved(rec)
            if hasattr(res, "__await__"):
                await res  # type: ignore[misc]
        return rec

    async def deny(self, approval_id: str, *, approver: str, reason: str | None = None) -> PendingApproval:
        rec = self._require(approval_id)
        rec.status = "denied"
        rec.approver = approver
        rec.deny_reason = reason
        return rec

    def _require(self, approval_id: str) -> PendingApproval:
        rec = self._by_id.get(approval_id)
        if rec is None:
            raise KeyError(approval_id)
        return rec
