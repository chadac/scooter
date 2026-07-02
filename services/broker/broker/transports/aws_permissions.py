"""aws-permissions transport — dynamic, approval-gated AWS access.

Mounts under /{provider}/aws/*. Every route authenticates via the SA token
(Depends(authed) -> Identity); conversation_id comes from the identity, NEVER the
body — so cross-conversation isolation + caller identity are free.

Agent-facing:
  GET    /aws/accounts                 discovery
  POST   /aws/request                  request a scoped permission
  POST   /aws/escalate                 request more (parent_request_id)
  GET    /aws/{request_id}             status + creds when active [isolated]
  POST   /aws/{request_id}/refresh     fresh STS creds within the role TTL
  DELETE /aws/{request_id}             self-revoke
Approver-facing (admin seam):
  POST   /aws/{request_id}/approve     pending -> active (provision)
  POST   /aws/{request_id}/deny        pending -> denied
  GET    /aws/audit                    audit query

The PermissionService does the work; these are thin adapters. The service is set
on the transport by the provider that builds both (set_service). is_admin is a
deployer-configured seam (default: any authenticated caller — the in-conversation
flow trusts the conversation user; tighten via config for a real boundary).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException

from ..aws.models import PermissionRequest, RequestStatus, StsCredentials
from ..aws.service import PermissionService, RequestError
from ..core.types import AuthDependency, Identity, Provider, Transport

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


@dataclass
class AwsPermissions(Transport):
    name: str = "aws-permissions"
    # Injected by the provider (build-time). is_admin gates approve/deny/audit.
    service: PermissionService | None = field(default=None)
    is_admin: Any = field(default=None)  # (Identity) -> bool; None => allow

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
                # Never leak a bare 500: surface the real exception so the agent can
                # act on it (e.g. an IAM/STS failure the request path didn't wrap).
                logger.exception("aws request failed unexpectedly")
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
        # Registered BEFORE /aws/{request_id} so "requests" isn't captured as an id.
        @router.get("/aws/requests")
        async def list_requests(identity: Identity = Depends(authed), target_account: str | None = None):
            reqs = await _svc().list_for_conversation(identity.conversation_id)
            if target_account:
                reqs = [r for r in reqs if r.target_account == target_account]
            return {"requests": [_request_view(r) for r in reqs]}

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
        @router.post("/aws/{request_id}/approve")
        async def approve(request_id: str, identity: Identity = Depends(authed), body: dict = Body(default={})):
            _admin_or_403(identity)
            approver = body.get("approver") or identity.conversation_id
            try:
                req = await _svc().approve(request_id=request_id, approver=approver)
            except RequestError as e:
                raise HTTPException(status_code=400, detail={"errors": e.reasons})
            return _request_view(req)

        @router.post("/aws/{request_id}/deny")
        async def deny(request_id: str, identity: Identity = Depends(authed), body: dict = Body(default={})):
            _admin_or_403(identity)
            approver = body.get("approver") or identity.conversation_id
            try:
                req = await _svc().deny(request_id=request_id, approver=approver, reason=body.get("reason"))
            except RequestError as e:
                raise HTTPException(status_code=400, detail={"errors": e.reasons})
            return _request_view(req)

        @router.get("/aws/audit")
        async def audit(identity: Identity = Depends(authed), target_account: str | None = None):
            _admin_or_403(identity)
            reqs = await _svc().query_audit(target_account=target_account)
            return {"requests": [_request_view(r) for r in reqs]}

        return router
