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


# Recorded as `approved_by` when a read-only request is auto-approved (no human).
AUTO_APPROVE_PRINCIPAL = "system:auto-approve-read-only"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _aws_error_reasons(exc: Exception, *, context: str) -> list[str]:
    """Turn an exception from the IAM/STS path into a verbose, fully-detailed list
    of reasons — nothing hidden. For a botocore ClientError we surface the error
    Code, the raw AWS Message, the failing operation, the HTTP status, the AWS
    request id, and the invoked ARN when present; for anything else, the exception
    type + str(). The `context` line (what we were trying to do + the likely
    fix) is prepended so the agent gets both the diagnosis AND the raw AWS truth."""
    reasons = [context]
    err = getattr(exc, "response", None)
    if isinstance(err, dict):
        e = err.get("Error", {}) or {}
        meta = err.get("ResponseMetadata", {}) or {}
        code = e.get("Code")
        msg = e.get("Message")
        op = getattr(exc, "operation_name", None)
        detail = "AWS error"
        if op:
            detail += f" on {op}"
        if code:
            detail += f" [{code}]"
        if msg:
            detail += f": {msg}"
        reasons.append(detail)
        http = meta.get("HTTPStatusCode")
        rid = meta.get("RequestId")
        extra = []
        if http:
            extra.append(f"HTTP {http}")
        if rid:
            extra.append(f"request-id {rid}")
        arn = e.get("Type") or meta.get("HTTPHeaders", {}).get("x-amzn-invoked-arn")
        if arn:
            extra.append(f"arn {arn}")
        if extra:
            reasons.append("(" + ", ".join(extra) + ")")
    else:
        reasons.append(f"{type(exc).__name__}: {exc}")
    return reasons


@dataclass
class ServiceConfig:
    """Durations (seconds) by risk + the role TTL (hours) + the broker principal."""

    duration_low: int = 3600       # 1h
    duration_medium: int = 1800    # 30m
    duration_high: int = 900       # 15m
    role_ttl_hours: int = 12
    broker_principal_arn: str = "" # the broker IRSA role ARN (dynamic-role trust)
    # Which identity claim to authorize an approver by — must match how the FGA
    # `approver` tuples are seeded (accounts.<a>.approvers, conventionally emails).
    # The agent-host sends {id, email, name}; this picks one. "email" | "id" | "name".
    approver_claim: str = "email"


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
                # Human-written summary of what this account is for, so the agent
                # can pick the right one to request access to (empty if unset).
                "description": acct.get("description", ""),
                "allowed_policy": acct.get("allowed_policy"),
                "allowed_managed_policies": acct.get("allowed_managed_policies", []),
                # Lets the agent prefer an account where a read-only request needs
                # no human (so it doesn't over-ask / wait needlessly).
                "auto_approve_read_only": bool(acct.get("auto_approve_read_only", False)),
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
        # NOTE: IAM provisioning (create the inline policy + role) is DEFERRED to
        # approval (_provision), NOT done eagerly here. So the request is always
        # stored PENDING and the human/agent SEES it, even when the account's broker
        # IAM isn't set up yet — the provisioning error then surfaces on approve
        # (and is fed back to the agent) instead of failing the request before it
        # ever appears in the conversation.
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
            iam_policy_arn=None,
        )
        await self._store.insert(req)

        # OPT-IN read-only auto-approval: if the account enables it and the request
        # is a pure read-only inline policy (no managed ARNs — those can grant
        # writes), grant it immediately with a synthetic system approver instead of
        # waiting for a human. Gated per-account (default off) so nothing is
        # auto-granted unless the deployment explicitly opted in for that account.
        if (
            acct.get("auto_approve_read_only", False)
            and not managed_policy_arns
            and policy_document is not None
            and policy.is_read_only_policy(policy_document)
        ):
            logger.info(
                "auto-approving read-only request %s for account '%s'", request_id, target_account
            )
            return await self._provision(req, approver=AUTO_APPROVE_PRINCIPAL)

        # Otherwise notify the agent-host so it raises the approval interrupt
        # (best-effort — a notify failure must not fail the request; user can poll).
        if self._on_request is not None:
            try:
                await self._on_request(req)
            except Exception:
                logger.exception("on_request notify failed for %s", request_id)
        return req

    # --- approver identity -------------------------------------------------
    def resolve_approver(self, approver, *, fallback: str) -> str:
        """Turn the request body's `approver` into the string the FGA check +
        approved_by record use. Accepts a full identity dict {id, email, name}
        (the agent-host sends the answering user's identity) and picks the
        configured claim (approver_claim: email|id|name); or a plain string
        (legacy/dev), used as-is. Falls back to `fallback` (the SA-token
        conversation id) when nothing usable is present."""
        if isinstance(approver, dict):
            claim = self._config.approver_claim or "email"
            return approver.get(claim) or approver.get("id") or fallback
        if isinstance(approver, str) and approver:
            # Strip a legacy "user:" prefix if present.
            return approver[len("user:"):] if approver.startswith("user:") else approver
        return fallback

    # --- approve / deny (approver) ----------------------------------------
    async def _authorize_approver(self, approver: str, target_account: str) -> None:
        """Enforce that `approver` may approve THIS account (OpenFGA). FGA off ->
        NoopAuthorizer -> always allowed. Fails closed if FGA is unreachable."""
        allowed = await self._authz.check(
            user=approver, relation="approver", obj=aws_account_object(target_account)
        )
        if not allowed:
            raise RequestError([f"'{approver}' is not authorized to approve account '{target_account}'"])

    async def _provision(self, req: PermissionRequest, approver: str) -> PermissionRequest:
        """Provision the inline policy + dynamic role + creds for an approved request
        and mark it ACTIVE. Shared by human approve() and read-only auto-approval —
        `approver` is the recorded approved_by (a real user, or a synthetic system
        principal). IAM provisioning (previously eager at request time) happens HERE,
        so a provisioning failure surfaces on approval as a VERBOSE, actionable error
        (fed back to the agent) instead of blocking the request from ever appearing."""
        approved_at = _now()
        role_expires_at = (
            datetime.now(timezone.utc) + timedelta(hours=self._config.role_ttl_hours)
        ).isoformat()
        duration = self._duration_for(req.risk_level)

        # 1. Create the inline policy (deferred from request time).
        policy_arn = req.iam_policy_arn
        try:
            if policy_arn is None and req.policy_document is not None:
                policy_arn = self._iam.create_dynamic_policy(
                    target_account=req.target_account,
                    request_id=req.request_id,
                    policy_document=req.policy_document,
                )
                await self._store.update(req.request_id, iam_policy_arn=policy_arn)
            # 2. Create the dynamic role + mint creds.
            role_arn, creds = self._iam.create_dynamic_role(
                target_account=req.target_account,
                request_id=req.request_id,
                policy_arn=policy_arn,
                managed_policy_arns=req.managed_policy_arns,
                duration_seconds=duration,
            )
        except Exception as exc:  # provisioning failed -> error state, VERBOSE reason
            reasons = _aws_error_reasons(
                exc,
                context=(
                    f"AWS access could not be provisioned for account '{req.target_account}'. "
                    "This usually means the account's broker IAM isn't set up yet: create the "
                    "`agent-token-broker-base` role + the `agent-broker-permission-boundary` "
                    "policy in that account, and grant the broker IRSA `sts:AssumeRole` into "
                    "the base role with the matching ExternalId. See docs/AWS_PERMISSIONS_BROKER.md."
                ),
            )
            await self._store.update(
                req.request_id, status=RequestStatus.ERROR, approved_at=approved_at,
                approved_by=approver, deny_reason=" | ".join(reasons),
            )
            raise RequestError(reasons) from exc

        self._creds[req.request_id] = creds
        await self._store.update(
            req.request_id,
            status=RequestStatus.ACTIVE,
            approved_at=approved_at,
            approved_by=approver,
            iam_role_arn=role_arn,
            role_expires_at=role_expires_at,
            credentials_issued_at=approved_at,
            expires_at=creds.expires_at,
        )
        return await self._store.get(req.request_id)  # type: ignore[return-value]

    async def approve(self, *, request_id: str, approver: str) -> PermissionRequest:
        req = await self._store.get(request_id)
        if req is None:
            raise RequestError([f"Unknown request '{request_id}'"])
        if req.status != RequestStatus.PENDING:
            raise RequestError([f"Request is {req.status.value}, not pending"])
        await self._authorize_approver(approver, req.target_account)
        return await self._provision(req, approver)

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

    async def can_approve(self, *, request_id: str, approver: str) -> bool:
        """Read-only: may `approver` approve THIS request's account? Powers the
        UI's greyed-out Approve button (per-VIEWER — the interrupt is raised once
        server-side but seen by many users). Resolves the account from the request
        (never trusts a client-supplied alias) and runs the same OpenFGA `approver`
        check as approve()/deny() — WITHOUT mutating. FGA off -> NoopAuthorizer ->
        True. Fails CLOSED (False) if the request is unknown or FGA is unreachable."""
        req = await self._store.get(request_id)
        if req is None:
            return False
        try:
            return await self._authz.check(
                user=approver, relation="approver", obj=aws_account_object(req.target_account)
            )
        except Exception:  # FGA unreachable -> fail closed (greyed button, not a false-allow)
            return False

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
