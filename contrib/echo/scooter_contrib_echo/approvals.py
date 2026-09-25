"""Echo's approval transport — a HUMAN-APPROVAL integration built only from the
public contrib seam.

Why this exists at all: aws was the only thing that ever raised an approval, so
"the approval mechanism" and "what aws needs" were indistinguishable, and the
end-to-end path could only be tested by mocking STS, IAM and OpenFGA. Every piece
had unit coverage and the whole still carried no approver identity (PR #649).

Echo asks for nothing real. It stores a request in memory, asks a human, and
records the answer — which is exactly enough to exercise the full loop:

    agent asks -> broker notifies the host -> interrupt in the conversation
      -> a person answers -> host relays the verb + WHO answered -> recorded here

and to let a test assert the one thing no unit test could: that the recorded
approver is the logged-in human, not the conversation. Why: PR #651.

In-memory on purpose. A contrib may declare its own tables (#637), but durability
across a broker restart is not what this proves, and a table would make the fixture
heavier than the thing it tests.
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
    #: WHO answered — the claim the agent-host relayed. The assertion that matters:
    #: a conversation id here means the human's identity was lost on the way.
    approver: str | None = None


def _view(rec: ApprovalRecord) -> dict[str, Any]:
    return {
        "request_id": rec.request_id,
        "conversation_id": rec.conversation_id,
        # The prose the human reads, rendered HERE — the platform relays it opaquely.
        "message": rec.message,
        "status": rec.status,
        "answered": rec.answered,
        "approver": rec.approver,
    }


@dataclass
class EchoApprovals(Transport):
    """Approval routes at /echo/approval/*, matching the shape the agent-host relays to.

    The host appends `/{request_id}/{optionId}` to the contrib's declared
    `brokerPrefix` and `?conversation_id=` to its `pendingPath` — see
    contrib/echo/default.nix, which declares both.
    """

    name: str = "approval"
    #: request_id -> record. Process-local; see the module docstring.
    requests: dict[str, ApprovalRecord] = field(default_factory=dict)
    #: Set by a test to make can-approve answer False, so the greyed-option path is
    #: reachable without standing up OpenFGA.
    deny_all: bool = False

    def _get(self, request_id: str) -> ApprovalRecord:
        rec = self.requests.get(request_id)
        if rec is None:
            raise HTTPException(status_code=404, detail="unknown request")
        return rec

    @staticmethod
    def _approver_of(body: dict) -> str | None:
        """Resolve the relayed approver to a single claim.

        Mirrors aws's rule (prefer email, else id) without its configurability: the
        point here is that SOMETHING identifying a person arrives, not which claim a
        deployment prefers.
        """
        approver = body.get("approver")
        if isinstance(approver, dict):
            return approver.get("email") or approver.get("id")
        if isinstance(approver, str) and approver:
            return approver
        return None

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()

        @router.post("/approval", status_code=201)
        async def request_approval(
            identity: Identity = Depends(authed), body: dict = Body(default={})
        ) -> dict[str, Any]:
            """The agent asks for something. Stored PENDING before anything else, so a
            failed notify costs a visible window and never the request itself."""
            rec = ApprovalRecord(
                request_id=uuid.uuid4().hex[:12],
                # The SA-token identity: the broker addresses a conversation by the
                # SHORT id parsed from `sandbox-{shortId}`, which is also what the
                # agent-host resolves against.
                conversation_id=identity.conversation_id,
                message=body.get("message") or "Echo is asking for approval (test fixture).",
            )
            self.requests[rec.request_id] = rec
            return _view(rec)

        # Registered BEFORE /approval/{request_id} so "pending" is not captured as an id.
        @router.get("/approval/pending")
        async def pending(
            identity: Identity = Depends(authed), conversation_id: str = ""
        ) -> dict[str, Any]:
            """Still-pending requests for a conversation — what the agent-host replays
            after a rollout to rebuild an approval window it lost."""
            if not conversation_id:
                raise HTTPException(status_code=400, detail="conversation_id required")
            open_ = [
                r
                for r in self.requests.values()
                if r.conversation_id == conversation_id and r.status == "pending"
            ]
            return {"requests": [_view(r) for r in open_]}

        @router.post("/approval/{request_id}/can-approve")
        async def can_approve(
            request_id: str, identity: Identity = Depends(authed), body: dict = Body(default={})
        ) -> dict[str, bool]:
            """May the VIEWER act on this? No admin gate — anyone may ask, and the
            answer is itself the authorization signal."""
            self._get(request_id)
            if self.deny_all:
                return {"can_approve": False}
            # A request answerable only by a named human. An identity that did not
            # survive the relay arrives as None and is refused, which is what makes
            # the greyed-option path and the relay agree about the same person.
            return {"can_approve": self._approver_of(body) is not None}

        @router.post("/approval/{request_id}/{verb}")
        async def answer(
            request_id: str,
            verb: str,
            identity: Identity = Depends(authed),
            body: dict = Body(default={}),
        ) -> dict[str, Any]:
            """Record the human's answer. The VERB is whatever option the user picked:
            the platform relays it as a path segment and does not interpret it."""
            rec = self._get(request_id)
            if verb not in ("approve", "deny"):
                raise HTTPException(status_code=400, detail={"errors": [f"unknown verb '{verb}'"]})
            if rec.status != "pending":
                # Already answered. A 409 rather than a silent overwrite: a second
                # answer means two people raced, and the first decision stands.
                raise HTTPException(
                    status_code=409, detail={"errors": [f"request already {rec.status}"]}
                )
            approver = self._approver_of(body)
            if approver is None:
                # The identity was lost somewhere between the browser and here. Refusing
                # loudly is the whole point of this fixture — PR #649 shipped with this
                # silently falling back to the conversation id.
                raise HTTPException(
                    status_code=400,
                    detail={"errors": ["no approver identity was relayed with the answer"]},
                )
            rec.answered = verb
            rec.approver = approver
            rec.status = "approved" if verb == "approve" else "denied"
            return _view(rec)

        @router.get("/approval/{request_id}")
        async def get_request(
            request_id: str, identity: Identity = Depends(authed)
        ) -> dict[str, Any]:
            """Read one record — how a test asserts WHO was recorded as the approver."""
            return _view(self._get(request_id))

        return router
