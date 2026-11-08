"""Echo's approval transport: a human-approval integration built only from the public contrib seam.

It stores a request in memory, asks a human through the agent-host, and records the
verb and who answered, which is enough to exercise the full approval loop and to
assert that the recorded approver is the logged-in human, not the conversation.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport


@dataclass
class ApprovalRecord:
    """One request and, once answered, how it was answered."""

    request_id: str
    conversation_id: str
    message: str
    status: str = "pending"
    #: The verb the human chose ("approve" / "deny"), once answered.
    answered: str | None = None
    #: The claim the agent-host relayed for who answered; a conversation id here means the human's identity was lost on the way.
    approver: str | None = None


def _view(rec: ApprovalRecord) -> dict[str, Any]:
    return {
        "request_id": rec.request_id,
        "conversation_id": rec.conversation_id,
        # The prose the human reads, which the platform relays opaquely.
        "message": rec.message,
        "status": rec.status,
        "answered": rec.answered,
        "approver": rec.approver,
    }


@dataclass
class EchoApprovals(Transport):
    """Approval routes at /echo/approvals/*, where the derived scooter.approvals.echo row points the agent-host."""

    name: str = "approvals"
    #: request_id -> record, process-local.
    requests: dict[str, ApprovalRecord] = field(default_factory=dict)
    #: Set by a test to make can-approve answer False without standing up OpenFGA.
    deny_all: bool = False

    def _get(self, request_id: str) -> ApprovalRecord:
        rec = self.requests.get(request_id)
        if rec is None:
            raise HTTPException(status_code=404, detail="unknown request")
        return rec

    @staticmethod
    def _approver_of(body: dict) -> str | None:
        """Resolve the relayed approver to a single claim, preferring email over id."""
        approver = body.get("approver")
        if isinstance(approver, dict):
            return approver.get("email") or approver.get("id")
        if isinstance(approver, str) and approver:
            return approver
        return None

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()

        @router.post("/approvals", status_code=201)
        async def request_approval(
            identity: Identity = Depends(authed), body: dict = Body(default={})
        ) -> dict[str, Any]:
            """The agent asks for something, stored pending before anything else."""
            rec = ApprovalRecord(
                request_id=uuid.uuid4().hex[:12],
                # The short id parsed from `sandbox-{shortId}`, which the agent-host resolves against.
                conversation_id=identity.conversation_id,
                message=body.get("message") or "Echo is asking for approval (test fixture).",
            )
            self.requests[rec.request_id] = rec
            return _view(rec)

        # Registered before /approvals/{request_id} so "pending" is not captured as an id.
        @router.get("/approvals/pending")
        async def pending(
            identity: Identity = Depends(authed), conversation_id: str = ""
        ) -> dict[str, Any]:
            """Still-pending requests for a conversation, which the agent-host replays after a rollout."""
            if not conversation_id:
                raise HTTPException(status_code=400, detail="conversation_id required")
            open_ = [
                r
                for r in self.requests.values()
                if r.conversation_id == conversation_id and r.status == "pending"
            ]
            return {"requests": [_view(r) for r in open_]}

        @router.post("/approvals/{request_id}/can-approve")
        async def can_approve(
            request_id: str, identity: Identity = Depends(authed), body: dict = Body(default={})
        ) -> dict[str, bool]:
            """Whether the viewer may act on this; anyone may ask, and the answer is the authorization signal."""
            self._get(request_id)
            if self.deny_all:
                return {"can_approve": False}
            # An identity that did not survive the relay arrives as None and is refused.
            return {"can_approve": self._approver_of(body) is not None}

        @router.post("/approvals/{request_id}/{verb}")
        async def answer(
            request_id: str,
            verb: str,
            identity: Identity = Depends(authed),
            body: dict = Body(default={}),
        ) -> dict[str, Any]:
            """Record the human's answer; the verb is the option the user picked, relayed uninterpreted as a path segment."""
            rec = self._get(request_id)
            if verb not in ("approve", "deny"):
                raise HTTPException(status_code=400, detail={"errors": [f"unknown verb '{verb}'"]})
            if rec.status != "pending":
                # Two people raced, and the first decision stands.
                raise HTTPException(
                    status_code=409, detail={"errors": [f"request already {rec.status}"]}
                )
            approver = self._approver_of(body)
            if approver is None:
                # The identity was lost somewhere between the browser and here.
                raise HTTPException(
                    status_code=400,
                    detail={"errors": ["no approver identity was relayed with the answer"]},
                )
            rec.answered = verb
            rec.approver = approver
            rec.status = "approved" if verb == "approve" else "denied"
            return _view(rec)

        @router.get("/approvals/{request_id}")
        async def get_request(
            request_id: str, identity: Identity = Depends(authed)
        ) -> dict[str, Any]:
            """Read one record."""
            return _view(self._get(request_id))

        return router
