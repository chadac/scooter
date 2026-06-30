"""Permission service — orchestrates the request lifecycle.

The transport (routes) is thin; this holds the logic, testable against a fake
IamProvisioner + a SQLite store. Wires policy guardrails + store + IamProvisioner
+ the in-memory credential cache.

Lifecycle (see models.RequestStatus):
  request()  -> validate (3 layers) -> create inline policy eagerly -> store pending
  approve()  -> create_dynamic_role -> cache creds -> active   (or error)
  deny()     -> delete the eager policy -> denied
  status()   -> the request + (if active & cached) its creds
  refresh()  -> re-assume the live role -> fresh cached creds
  revoke()   -> tear down role+policy -> revoked
  sweep_expired() -> tear down roles past role_expires_at -> expired
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

from . import policy
from ..core.authz import Authorizer, NoopAuthorizer, aws_account_object
from .iam import IamProvisioner
from .models import PermissionRequest, RequestStatus, RiskLevel, StsCredentials
from .store import PermissionStore


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class ServiceConfig:
    """Durations (seconds) by risk + the role TTL (hours) + the broker principal."""

    duration_low: int = 3600       # 1h
    duration_medium: int = 1800    # 30m
    duration_high: int = 900       # 15m
    role_ttl_hours: int = 12
    broker_principal_arn: str = "" # the broker IRSA role ARN (dynamic-role trust)


class RequestError(Exception):
    """Validation / authorization failure with a list of human-readable reasons."""

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("; ".join(reasons))
        self.reasons = reasons


class PermissionService:
    def __init__(
        self,
        *,
        store: PermissionStore,
        iam: IamProvisioner,
        account_registry: dict[str, dict],
        config: ServiceConfig,
        on_request=None,  # async (PermissionRequest) -> None; notify the host to
                          # raise the approval interrupt. None = no notify.
        authorizer: Authorizer | None = None,  # per-account approve/deny gate;
                          # None -> NoopAuthorizer (FGA off -> allow, today's behavior).
    ) -> None:
        self._store = store
        self._iam = iam
        self._registry = account_registry
        self._config = config
        self._on_request = on_request
        self._authz: Authorizer = authorizer or NoopAuthorizer()
        # request_id -> StsCredentials. In-memory only; never persisted.
        self._creds: dict[str, StsCredentials] = {}

    # --- account discovery -------------------------------------------------
    async def accounts(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for name, acct in self._registry.items():
            if not acct.get("enabled", False):
                continue
            out[name] = {
                "account_id": acct.get("account_id"),
                "allowed_policy": acct.get("allowed_policy"),
                "allowed_managed_policies": acct.get("allowed_managed_policies", []),
            }
        return out

    # --- request (agent) ---------------------------------------------------
    async def request(
        self,
        *,
        conversation_id: str,
        target_account: str,
        justification: str,
        policy_document: dict | None = None,
        managed_policy_arns: list[str] | None = None,
        conversation_url: str | None = None,
        parent_request_id: str | None = None,
    ) -> PermissionRequest:
        managed_policy_arns = managed_policy_arns or []
        acct = self._registry.get(target_account)
        if acct is None or not acct.get("enabled", False):
            raise RequestError([f"Account '{target_account}' is not available"])
        if policy_document is None and not managed_policy_arns:
            raise RequestError(["Must supply policy_document and/or managed_policy_arns"])

        # Managed-policy ARNs must be allowlisted for the account.
        allowed_managed = set(acct.get("allowed_managed_policies", []))
        for arn in managed_policy_arns:
            if arn not in allowed_managed:
                raise RequestError([f"Managed policy '{arn}' is not allowed for this account"])

        risk = RiskLevel.LOW
        summary = ""
        if policy_document is not None:
            errors = policy.validate_policy(policy_document, target_account)
            allowed_policy = acct.get("allowed_policy") or {"Statement": [{"Action": ["*"], "Resource": ["*"]}]}
            errors += policy.validate_policy_within_bounds(policy_document, allowed_policy)
            if errors:
                raise RequestError(errors)
            risk = policy.classify_risk(policy_document, target_account)
            summary = policy.summarize_policy(policy_document)

        request_id = uuid.uuid4().hex[:12]
        # Eagerly create the inline policy so policy errors surface before approval.
        policy_arn = None
        if policy_document is not None:
            policy_arn = self._iam.create_dynamic_policy(
                target_account=target_account, request_id=request_id, policy_document=policy_document
            )

        req = PermissionRequest(
            request_id=request_id,
            conversation_id=conversation_id,
            target_account=target_account,
            justification=justification,
            status=RequestStatus.PENDING,
            risk_level=risk,
            policy_document=policy_document,
            managed_policy_arns=managed_policy_arns,
            policy_summary=summary,
            conversation_url=conversation_url,
            parent_request_id=parent_request_id,
            requested_at=_now(),
            iam_policy_arn=policy_arn,
        )
        await self._store.insert(req)
        # Notify the agent-host so it raises the approval interrupt (best-effort —
        # a notify failure must not fail the request; the user can also poll).
        if self._on_request is not None:
            try:
                await self._on_request(req)
            except Exception:
                logger.exception("on_request notify failed for %s", request_id)
        return req

    # --- approve / deny (approver) ----------------------------------------
    async def _authorize_approver(self, approver: str, target_account: str) -> None:
        """Enforce that `approver` may approve THIS account (OpenFGA). FGA off ->
        NoopAuthorizer -> always allowed. Fails closed if FGA is unreachable."""
        allowed = await self._authz.check(
            user=approver, relation="approver", obj=aws_account_object(target_account)
        )
        if not allowed:
            raise RequestError([f"'{approver}' is not authorized to approve account '{target_account}'"])

    async def approve(self, *, request_id: str, approver: str) -> PermissionRequest:
        req = await self._store.get(request_id)
        if req is None:
            raise RequestError([f"Unknown request '{request_id}'"])
        if req.status != RequestStatus.PENDING:
            raise RequestError([f"Request is {req.status.value}, not pending"])
        await self._authorize_approver(approver, req.target_account)

        approved_at = _now()
        role_expires_at = (
            datetime.now(timezone.utc) + timedelta(hours=self._config.role_ttl_hours)
        ).isoformat()
        duration = self._duration_for(req.risk_level)
        try:
            role_arn, creds = self._iam.create_dynamic_role(
                target_account=req.target_account,
                request_id=req.request_id,
                policy_arn=req.iam_policy_arn,
                managed_policy_arns=req.managed_policy_arns,
                duration_seconds=duration,
            )
        except Exception as exc:  # provisioning failed -> error state
            await self._store.update(
                request_id, status=RequestStatus.ERROR, approved_at=approved_at,
                approved_by=approver, deny_reason=f"provisioning failed: {exc}",
            )
            raise RequestError([f"IAM provisioning failed: {exc}"]) from exc

        self._creds[request_id] = creds
        await self._store.update(
            request_id,
            status=RequestStatus.ACTIVE,
            approved_at=approved_at,
            approved_by=approver,
            iam_role_arn=role_arn,
            role_expires_at=role_expires_at,
            credentials_issued_at=approved_at,
            expires_at=creds.expires_at,
        )
        return await self._store.get(request_id)  # type: ignore[return-value]

    async def deny(self, *, request_id: str, approver: str, reason: str | None = None) -> PermissionRequest:
        req = await self._store.get(request_id)
        if req is None:
            raise RequestError([f"Unknown request '{request_id}'"])
        await self._authorize_approver(approver, req.target_account)
        # Finding #19: if a policy was already provisioned, its teardown must
        # SUCCEED before we record this request as terminal — else we orphan the
        # IAM policy while the DB claims it's gone (state drift, lying audit trail).
        # delete_dynamic_policy logs + returns False on a real failure; surface it.
        if req.iam_policy_arn and not self._iam.delete_dynamic_policy(
            target_account=req.target_account, policy_arn=req.iam_policy_arn
        ):
            raise RequestError(
                [f"Failed to delete IAM policy for '{request_id}'; not marking denied (will retry)"]
            )
        await self._store.update(
            request_id, status=RequestStatus.DENIED, denied_at=_now(),
            denied_by=approver, deny_reason=reason,
        )
        return await self._store.get(request_id)  # type: ignore[return-value]

    # --- retrieve / refresh / revoke (agent) -------------------------------
    async def status(
        self, *, request_id: str, conversation_id: str
    ) -> tuple[PermissionRequest | None, StsCredentials | None]:
        req = await self._store.get_for_conversation(request_id, conversation_id)
        if req is None:
            return None, None
        creds = self._creds.get(request_id) if req.status == RequestStatus.ACTIVE else None
        return req, creds

    async def refresh(self, *, request_id: str, conversation_id: str) -> tuple[PermissionRequest, StsCredentials]:
        req = await self._store.get_for_conversation(request_id, conversation_id)
        if req is None:
            raise RequestError([f"Unknown request '{request_id}'"])
        if req.status != RequestStatus.ACTIVE or not req.iam_role_arn:
            raise RequestError(["Request is not active"])
        if req.role_expires_at and req.role_expires_at <= _now():
            raise RequestError(["Role TTL has passed — request again"])
        creds = self._iam.assume_dynamic_role(
            target_account=req.target_account, role_arn=req.iam_role_arn,
            request_id=req.request_id, duration_seconds=self._duration_for(req.risk_level),
        )
        self._creds[request_id] = creds
        await self._store.update(request_id, credentials_issued_at=_now(), expires_at=creds.expires_at)
        return req, creds

    async def revoke(self, *, request_id: str, conversation_id: str) -> PermissionRequest:
        req = await self._store.get_for_conversation(request_id, conversation_id)
        if req is None:
            raise RequestError([f"Unknown request '{request_id}'"])
        # Finding #6: the IAM role/policy teardown must SUCCEED before we record
        # the request as REVOKED — otherwise a live dynamic role (with a trust
        # policy letting the broker assume it) is orphaned while the DB says it's
        # gone, and list_expired_active only re-sweeps ACTIVE/APPROVED, so a
        # terminal status is never retried. On a teardown failure (the helper logs
        # + returns False), keep the request non-terminal and raise so the caller
        # sees it; the role stays selectable for the next sweep/revoke.
        if req.iam_role_arn:
            torn_down = self._iam.delete_dynamic_role(
                target_account=req.target_account, role_arn=req.iam_role_arn, policy_arn=req.iam_policy_arn,
            )
        elif req.iam_policy_arn:
            torn_down = self._iam.delete_dynamic_policy(
                target_account=req.target_account, policy_arn=req.iam_policy_arn
            )
        else:
            torn_down = True
        if not torn_down:
            raise RequestError(
                [f"Failed to delete IAM resources for '{request_id}'; not marking revoked (will retry)"]
            )
        self._creds.pop(request_id, None)
        await self._store.update(request_id, status=RequestStatus.REVOKED, revoked_at=_now())
        return await self._store.get(request_id)  # type: ignore[return-value]

    # --- lifecycle sweep (background) -------------------------------------
    async def sweep_expired(self) -> list[str]:
        swept: list[str] = []
        for req in await self._store.list_expired_active(_now()):
            # Finding #6: only mark EXPIRED when the teardown actually succeeded.
            # On failure the helper logs + returns False; leave the request
            # ACTIVE/APPROVED so the NEXT sweep retries it (list_expired_active
            # re-selects it) instead of orphaning the live role behind a terminal
            # status that's never revisited.
            if req.iam_role_arn and not self._iam.delete_dynamic_role(
                target_account=req.target_account, role_arn=req.iam_role_arn, policy_arn=req.iam_policy_arn,
            ):
                logger.error(
                    "sweep_expired: IAM teardown failed for %s; leaving non-terminal for retry",
                    req.request_id,
                )
                continue
            self._creds.pop(req.request_id, None)
            await self._store.update(req.request_id, status=RequestStatus.EXPIRED)
            swept.append(req.request_id)
        return swept

    async def list_for_conversation(self, conversation_id: str) -> list[PermissionRequest]:
        """The caller's own requests (isolation)."""
        return await self._store.list_for_conversation(conversation_id)

    async def query_audit(self, **filters) -> list[PermissionRequest]:
        return await self._store.query_audit(**filters)

    def _duration_for(self, risk: RiskLevel) -> int:
        return {
            RiskLevel.LOW: self._config.duration_low,
            RiskLevel.MEDIUM: self._config.duration_medium,
            RiskLevel.HIGH: self._config.duration_high,
        }[risk]
