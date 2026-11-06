"""aws-permissions transport: dynamic, approval-gated AWS access.

Thin adapters over the PermissionService, mounted under /{provider}/aws/*. Every
route authenticates via the SA token and takes conversation_id from the identity,
never the body, so cross-conversation isolation is free; the approver routes are
additionally gated by `is_admin`.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from .models import APPROVAL_KIND, PermissionRequest, RequestStatus, StsCredentials, approval_data, approval_message, decision_message
from .service import NotPending, PermissionService, RequestError
from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport

logger = logging.getLogger(__name__)


def _request_view(req: PermissionRequest, creds: StsCredentials | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "request_id": req.request_id,
        "status": req.status.value,
        "risk_level": req.risk_level.value,
        "target_account": req.target_account,
        "policy_summary": req.policy_summary,
        "justification": req.justification,
        "requested_at": req.requested_at,
        "approved_by": req.approved_by,
        "expires_at": req.expires_at,
        "parent_request_id": req.parent_request_id,
        # The approval-window prose, carried on the view so the agent-host's re-raise after a rollout words it the same.
        "message": approval_message(req),
    }
    if creds is not None:
        out["credentials"] = {
            "access_key_id": creds.access_key_id,
            "secret_access_key": creds.secret_access_key,
            "session_token": creds.session_token,
            "region": creds.region,
            "expires_at": creds.expires_at,
        }
    return out


def _decision_view(req: PermissionRequest) -> dict[str, Any]:
    """An approve/deny answer; the agent-host prompts the agent with `agent_message`."""
    out = _request_view(req)
    message = decision_message(req)
    if message:
        out["agent_message"] = message
    return out


def _refused(verb: str, request_id: str, approver: str, e: RequestError) -> HTTPException:
    """Log why an approve/deny was refused; 409 when the request no longer awaits one."""
    extra = {"request_id": request_id, "approver": approver, "verb": verb, "reasons": e.reasons}
    if isinstance(e, NotPending):
        logger.info(
            "answer for a request that is not pending",
            extra={**extra, "status": e.status.value, "superseded_by": e.superseded_by},
        )
        return HTTPException(
            status_code=409,
            detail={"status": e.status.value, "superseded_by": e.superseded_by, "errors": e.reasons},
        )
    logger.warning("answer refused", extra=extra)
    return HTTPException(status_code=400, detail={"errors": e.reasons})


@dataclass
class AwsPermissions(Transport):
    name: str = "aws-permissions"
    # Injected by the provider via set_service.
    service: PermissionService | None = field(default=None)
    is_admin: Any = field(default=None)  # (Identity) -> bool gating approve/deny/audit; None allows

    def set_service(self, service: PermissionService, is_admin=None) -> None:
        self.service = service
        self.is_admin = is_admin

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        svc = self.service
        is_admin = self.is_admin

        def _svc() -> PermissionService:
            if svc is None:
                raise HTTPException(status_code=503, detail="aws permissions not configured")
            return svc

        def _admin_or_403(identity: Identity) -> None:
            if is_admin is not None and not is_admin(identity):
                raise HTTPException(status_code=403, detail="not an approver")

        # --- agent: discovery + request ------------------------------------
        @router.get("/aws/accounts")
        async def accounts(identity: Identity = Depends(authed)):
            return {"accounts": await _svc().accounts()}

        @router.post("/aws/request", status_code=201)
        async def request(identity: Identity = Depends(authed), body: dict = Body(...)):
            try:
                req = await _svc().request(
                    conversation_id=identity.conversation_id,
                    target_account=body["target_account"],
                    justification=body.get("justification", ""),
                    policy_document=body.get("policy_document"),
                    managed_policy_arns=body.get("managed_policy_arns"),
                    conversation_url=body.get("conversation_url"),
                )
            except KeyError as e:
                raise HTTPException(status_code=400, detail=f"missing field: {e}")
            except RequestError as e:
                raise HTTPException(status_code=400, detail={"errors": e.reasons})
            except Exception as e:
                # Surface the real exception so the agent can act on it.
                logger.exception(
                    "aws request failed unexpectedly",
                    extra={
                        "conversation_id": identity.conversation_id,
                        "target_account": body.get("target_account"),
                    },
                )
                raise HTTPException(status_code=500, detail={"errors": [f"{type(e).__name__}: {e}"]})
            return _request_view(req)

        @router.post("/aws/escalate", status_code=201)
        async def escalate(identity: Identity = Depends(authed), body: dict = Body(...)):
            try:
                req = await _svc().request(
                    conversation_id=identity.conversation_id,
                    target_account=body["target_account"],
                    justification=body.get("justification", ""),
                    policy_document=body.get("policy_document"),
                    managed_policy_arns=body.get("managed_policy_arns"),
                    parent_request_id=body["parent_request_id"],
                )
            except KeyError as e:
                raise HTTPException(status_code=400, detail=f"missing field: {e}")
            except RequestError as e:
                raise HTTPException(status_code=400, detail={"errors": e.reasons})
            return _request_view(req)

        # --- agent: list own requests (isolated) ---------------------------
        # Registered before /aws/{request_id} so "requests" is not captured as an id.
        @router.get("/aws/requests")
        async def list_requests(identity: Identity = Depends(authed), target_account: str | None = None):
            reqs = await _svc().list_for_conversation(identity.conversation_id)
            if target_account:
                reqs = [r for r in reqs if r.target_account == target_account]
            return {"requests": [_request_view(r) for r in reqs]}

        # --- approver/agent-host: pending requests for a named conversation ---
        # Admin-gated and keyed by an explicit conversation_id; the agent-host calls it on revive to re-raise the approval interrupts a rollout dropped.
        @router.get("/aws/pending")
        async def pending(
            identity: Identity = Depends(authed), conversation_id: str = "",
        ):
            _admin_or_403(identity)
            if not conversation_id:
                raise HTTPException(status_code=400, detail="conversation_id required")
            reqs = await _svc().list_for_conversation(conversation_id)
            pend = [r for r in reqs if r.status == RequestStatus.PENDING]
            # kind+data let the re-raised window draw the same detail card.
            return {"requests": [{**_request_view(r), "kind": APPROVAL_KIND, "data": approval_data(r)} for r in pend]}

        # --- agent: status / refresh / revoke (isolated) -------------------
        @router.get("/aws/{request_id}")
        async def status(request_id: str, identity: Identity = Depends(authed)):
            req, creds = await _svc().status(request_id=request_id, conversation_id=identity.conversation_id)
            if req is None:
                raise HTTPException(status_code=404, detail="not found")
            return _request_view(req, creds)

        @router.post("/aws/{request_id}/refresh")
        async def refresh(request_id: str, identity: Identity = Depends(authed)):
            try:
                req, creds = await _svc().refresh(request_id=request_id, conversation_id=identity.conversation_id)
            except RequestError as e:
                raise HTTPException(status_code=400, detail={"errors": e.reasons})
            return _request_view(req, creds)

        @router.delete("/aws/{request_id}")
        async def revoke(request_id: str, identity: Identity = Depends(authed)):
            try:
                req = await _svc().revoke(request_id=request_id, conversation_id=identity.conversation_id)
            except RequestError as e:
                raise HTTPException(status_code=400, detail={"errors": e.reasons})
            return _request_view(req)

        # --- approver (admin seam) -----------------------------------------
        # The body's `approver` is an identity dict or a plain string, resolved by the service; can-approve has no admin gate because the answer is itself the authorization signal.
        @router.post("/aws/{request_id}/can-approve")
        async def can_approve(request_id: str, identity: Identity = Depends(authed), body: dict = Body(default={})):
            approver = _svc().resolve_approver(body.get("approver"), fallback=identity.conversation_id)
            allowed = await _svc().can_approve(request_id=request_id, approver=approver)
            return {"can_approve": allowed}

        @router.post("/aws/{request_id}/approve")
        async def approve(request_id: str, identity: Identity = Depends(authed), body: dict = Body(default={})):
            _admin_or_403(identity)
            approver = _svc().resolve_approver(body.get("approver"), fallback=identity.conversation_id)
            try:
                req = await _svc().approve(request_id=request_id, approver=approver)
            except RequestError as e:
                raise _refused("approve", request_id, approver, e)
            return _decision_view(req)

        @router.post("/aws/{request_id}/deny")
        async def deny(request_id: str, identity: Identity = Depends(authed), body: dict = Body(default={})):
            _admin_or_403(identity)
            approver = _svc().resolve_approver(body.get("approver"), fallback=identity.conversation_id)
            try:
                req = await _svc().deny(request_id=request_id, approver=approver, reason=body.get("reason"))
            except RequestError as e:
                raise _refused("deny", request_id, approver, e)
            return _decision_view(req)

        @router.get("/aws/audit")
        async def audit(identity: Identity = Depends(authed), target_account: str | None = None):
            _admin_or_403(identity)
            reqs = await _svc().query_audit(target_account=target_account)
            return {"requests": [_request_view(r) for r in reqs]}

        return router
