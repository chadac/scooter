"""Permission service: the request lifecycle behind the thin transport routes.

Wires the policy guardrails, the store, the IamProvisioner and the in-memory
credential cache; see models.RequestStatus for the states a request moves through.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

logger = logging.getLogger(__name__)

from . import policy, rules
from scooter_broker_lib.authz import Authorizer, NoopAuthorizer, user_object

from .objects import aws_account_object
from .iam import IamProvisioner
from .models import PermissionRequest, RequestStatus, RiskLevel, StsCredentials
from .store import PermissionStore


# `approved_by` when the approval rules grant without a human.
AUTO_APPROVE_PRINCIPAL = "system:auto-approve"

# Re-vend an STS token this many seconds before its expiry so status() never hands out one that expires mid-call.
_CREDS_REFRESH_SKEW = 300

# A request whose teardown keeps failing is forced to EXPIRED once its creds lapsed longer ago than this.
_FORCE_EXPIRE_GRACE_HOURS = 2


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _aws_error_reasons(exc: Exception, *, context: str) -> list[str]:
    """Turn an IAM/STS exception into a list of reasons, prefixed by `context`, with every AWS detail kept."""
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
    """Durations (seconds) by risk, the role TTL (hours) and the broker principal."""

    duration_low: int = 3600
    duration_medium: int = 1800
    duration_high: int = 900
    role_ttl_hours: int = 12
    broker_principal_arn: str = ""  # the broker IRSA role ARN the dynamic roles trust
    # Which identity claim ("email" | "id" | "name") an approver is authorized by; must match how the FGA `approver` tuples are seeded.
    approver_claim: str = "email"


class RequestError(Exception):
    """Validation / authorization failure with a list of human-readable reasons."""

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("; ".join(reasons))
        self.reasons = reasons


class NotPending(RequestError):
    """An approve/deny for a request that no longer awaits an answer."""

    def __init__(self, req: PermissionRequest, superseded_by: str | None = None) -> None:
        reason = f"Request '{req.request_id}' is {req.status.value}, not pending"
        if superseded_by:
            reason += f"; it was replaced by '{superseded_by}'"
        super().__init__([reason])
        self.status = req.status
        self.superseded_by = superseded_by


class PermissionService:
    def __init__(
        self,
        *,
        store: PermissionStore,
        iam: IamProvisioner,
        account_registry: dict[str, dict],
        config: ServiceConfig,
        on_request=None,  # async (PermissionRequest) -> None that asks the host to raise the approval interrupt
        on_withdraw=None,  # async (PermissionRequest) -> None that asks the host to drop a superseded interrupt
        authorizer: Authorizer | None = None,  # per-account approve/deny gate; None means NoopAuthorizer
    ) -> None:
        self._store = store
        self._iam = iam
        self._registry = account_registry
        self._config = config
        self._on_request = on_request
        self._on_withdraw = on_withdraw
        self._authz: Authorizer = authorizer or NoopAuthorizer()
        # request_id -> StsCredentials, in-memory only.
        self._creds: dict[str, StsCredentials] = {}

    # --- account discovery -------------------------------------------------
    async def accounts(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for name, acct in self._registry.items():
            if not acct.get("enabled", False):
                continue
            out[name] = {
                "account_id": acct.get("account_id"),
                # Human-written summary the agent uses to pick the right account.
                "description": acct.get("description", ""),
                "allowed_policy": acct.get("allowed_policy"),
                "allowed_managed_policies": acct.get("allowed_managed_policies", []),
                # Lets the agent prefer an account where a read-only request needs no human.
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
        account_rules = self._rules_for(target_account)

        # Managed-policy ARNs must be allowlisted for the account.
        allowed_managed = set(acct.get("allowed_managed_policies", []))
        for arn in managed_policy_arns:
            if arn not in allowed_managed:
                raise RequestError([f"Managed policy '{arn}' is not allowed for this account"])

        errors: list[str] = []
        if policy_document is not None:
            errors += policy.validate_policy(policy_document, target_account)
            allowed_policy = acct.get("allowed_policy") or {"Statement": [{"Action": ["*"], "Resource": ["*"]}]}
            errors += policy.validate_policy_within_bounds(policy_document, allowed_policy)
        parts = rules.request_parts(policy_document, managed_policy_arns)
        errors += rules.denials(account_rules, parts)
        if errors:
            raise RequestError(errors)

        risk = RiskLevel.LOW
        summary = ""
        if policy_document is not None:
            risk = policy.classify_risk(policy_document, target_account)
            summary = policy.summarize_policy(policy_document)

        needed = rules.obligations(target_account, account_rules, parts)

        request_id = uuid.uuid4().hex[:12]
        # IAM provisioning is deferred to _provision so a request always appears as pending even when the account's broker IAM is not set up yet.
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
            approval_obligations=[o.to_json() for o in needed] or None,
        )
        await self._store.insert(req)

        # Cancel older pending siblings now; active ones keep working until this request is approved.
        await self._supersede_pending_siblings(req)

        if not needed:
            logger.info(
                "auto-approving request",
                extra={
                    "conversation_id": req.conversation_id,
                    "request_id": request_id,
                    "target_account": target_account,
                    "auto_approve_reason": "approval_rules",
                },
            )
            return await self._provision(req, approver=AUTO_APPROVE_PRINCIPAL)

        await self._notify(req)
        return req

    def _rules_for(self, target_account: str) -> list[rules.Rule]:
        """The account's approval rules; refuses a registry rendered without them."""
        raw = self._registry[target_account].get("approval_rules")
        if raw is None:
            raise RequestError([
                f"Account '{target_account}' has no approval_rules; the account registry must be "
                "rendered by the contribs.aws Nix module"
            ])
        try:
            return rules.parse_rules(raw)
        except ValueError as e:
            raise RequestError([str(e)]) from e

    async def _notify(self, req: PermissionRequest) -> None:
        # Best-effort notify so the agent-host raises the approval interrupt; a failure must not fail the request.
        if self._on_request is not None:
            try:
                await self._on_request(req)
            except Exception:
                logger.exception(
                    "on_request notify failed",
                    extra={
                        "conversation_id": req.conversation_id,
                        "request_id": req.request_id,
                        "target_account": req.target_account,
                    },
                )

    async def _withdraw(self, req: PermissionRequest) -> None:
        # Best effort: a card left behind is answered with a harmless NotPending.
        if self._on_withdraw is not None:
            try:
                await self._on_withdraw(req)
            except Exception:
                logger.exception(
                    "on_withdraw notify failed",
                    extra={
                        "conversation_id": req.conversation_id,
                        "request_id": req.request_id,
                        "target_account": req.target_account,
                    },
                )

    async def _not_pending(self, req: PermissionRequest) -> NotPending:
        """The refusal for answering `req`, naming the request that replaced it."""
        superseded_by = None
        if req.status == RequestStatus.SUPERSEDED:
            newer = [r for r in await self._siblings(req) if r.requested_at > req.requested_at]
            if newer:
                superseded_by = max(newer, key=lambda r: r.requested_at).request_id
        return NotPending(req, superseded_by)

    # --- approver identity -------------------------------------------------
    def resolve_approver(self, approver, *, fallback: str) -> str:
        """Turn the request body's `approver` (an identity dict or a plain string) into the principal the FGA check and approved_by use."""
        if isinstance(approver, dict):
            claim = self._config.approver_claim or "email"
            return approver.get(claim) or approver.get("id") or fallback
        if isinstance(approver, str) and approver:
            return approver[len("user:"):] if approver.startswith("user:") else approver
        return fallback

    # --- approve / deny (approver) ----------------------------------------
    def _obligations(self, req: PermissionRequest) -> list[rules.Obligation]:
        """Stored obligations; older requests need one account approval."""
        if req.approval_obligations is None:
            return [rules.Obligation(id="0", rules=[rules.ACCOUNT_DEFAULT],
                                     objects=[aws_account_object(req.target_account)])]
        return [rules.Obligation.from_json(o) for o in req.approval_obligations]

    async def _eligible(self, approver: str, obligations: list[rules.Obligation]) -> list[str]:
        """Obligation ids `approver` may satisfy; FGA errors propagate."""
        user = user_object(approver)
        allowed: dict[str, bool] = {}
        out: list[str] = []
        for o in obligations:
            for obj in o.objects:
                if obj not in allowed:
                    allowed[obj] = await self._authz.check(user=user, relation="approver", obj=obj)
                if allowed[obj]:
                    out.append(o.id)
                    break
        return out

    @staticmethod
    def _unmet(req: PermissionRequest, obligations: list[rules.Obligation]) -> list[rules.Obligation]:
        done = {i for a in req.approvals for i in a.get("obligations", [])}
        return [o for o in obligations if o.id not in done]

    async def _provision(self, req: PermissionRequest, approver: str) -> PermissionRequest:
        """Provision the inline policy, dynamic role and creds for an approved request and mark it active, recording `approver` as approved_by."""
        approved_at = _now()
        role_expires_at = (
            datetime.now(timezone.utc) + timedelta(hours=self._config.role_ttl_hours)
        ).isoformat()
        duration = self._duration_for(req.risk_level)

        policy_arn = req.iam_policy_arn
        try:
            if policy_arn is None and req.policy_document is not None:
                policy_arn = self._iam.create_dynamic_policy(
                    target_account=req.target_account,
                    request_id=req.request_id,
                    policy_document=req.policy_document,
                )
                await self._store.update(req.request_id, iam_policy_arn=policy_arn)
            role_arn, creds = self._iam.create_dynamic_role(
                target_account=req.target_account,
                request_id=req.request_id,
                policy_arn=policy_arn,
                managed_policy_arns=req.managed_policy_arns,
                duration_seconds=duration,
            )
        except Exception as exc:
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
        # Only now that the new grant is live is the older active sibling torn down, so the agent never loses access in between.
        await self._supersede_active_siblings(req)
        return await self._store.get(req.request_id)  # type: ignore[return-value]

    # --- supersede: keep one live grant per (conversation, account) --------
    async def _siblings(self, req: PermissionRequest) -> list[PermissionRequest]:
        """Other requests for the same conversation and account as `req`."""
        return [
            r
            for r in await self._store.list_for_conversation(req.conversation_id)
            if r.request_id != req.request_id and r.target_account == req.target_account
        ]

    async def _supersede_pending_siblings(self, req: PermissionRequest) -> None:
        """Mark not-yet-active siblings SUPERSEDED and withdraw their interrupts; they hold no IAM role yet."""
        for sib in await self._siblings(req):
            if sib.status in (RequestStatus.PENDING, RequestStatus.APPROVED):
                await self._store.update(sib.request_id, status=RequestStatus.SUPERSEDED)
                logger.info(
                    "superseded pending request",
                    extra={
                        "conversation_id": sib.conversation_id,
                        "request_id": sib.request_id,
                        "superseded_by": req.request_id,
                        "target_account": sib.target_account,
                    },
                )
                await self._withdraw(sib)

    async def _supersede_active_siblings(self, req: PermissionRequest) -> None:
        """Tear down and supersede older active siblings so one grant is live per (conversation, account); a teardown failure is logged, never fails the new grant."""
        for sib in await self._siblings(req):
            if sib.status != RequestStatus.ACTIVE:
                continue
            try:
                if sib.iam_role_arn:
                    self._iam.delete_dynamic_role(
                        target_account=sib.target_account,
                        role_arn=sib.iam_role_arn,
                        policy_arn=sib.iam_policy_arn,
                    )
                elif sib.iam_policy_arn:
                    self._iam.delete_dynamic_policy(
                        target_account=sib.target_account, policy_arn=sib.iam_policy_arn
                    )
            except Exception:
                logger.exception(
                    "IAM teardown failed while superseding sibling",
                    extra={
                        "conversation_id": sib.conversation_id,
                        "request_id": sib.request_id,
                        "target_account": sib.target_account,
                        "role_arn": sib.iam_role_arn,
                        "policy_arn": sib.iam_policy_arn,
                    },
                )
            self._creds.pop(sib.request_id, None)
            await self._store.update(sib.request_id, status=RequestStatus.SUPERSEDED)

    async def approve(self, *, request_id: str, approver: str) -> PermissionRequest:
        """Record an approval; provision once no obligation is unmet."""
        req = await self._store.get(request_id)
        if req is None:
            raise RequestError([f"Unknown request '{request_id}'"])
        if req.status != RequestStatus.PENDING:
            raise await self._not_pending(req)
        unmet = self._unmet(req, self._obligations(req))
        satisfied = await self._eligible(approver, unmet)
        if not satisfied:
            raise RequestError([f"'{approver}' is not authorized to approve what request '{request_id}' still needs"])
        if not await self._store.add_approval(request_id, approver, _now(), satisfied):
            raise RequestError([f"'{approver}' has already approved request '{request_id}'"])
        req = await self._store.get(request_id)  # type: ignore[assignment]
        if self._unmet(req, unmet):
            # The answered interrupt is gone; re-raise for the rest.
            await self._notify(req)
            return req
        approvers = ", ".join(dict.fromkeys(a["approver"] for a in req.approvals))
        return await self._provision(req, approvers)

    async def deny(self, *, request_id: str, approver: str, reason: str | None = None) -> PermissionRequest:
        req = await self._store.get(request_id)
        if req is None:
            raise RequestError([f"Unknown request '{request_id}'"])
        # Denying an active grant would orphan its role; revoke tears it down instead.
        if req.status != RequestStatus.PENDING:
            raise await self._not_pending(req)
        # Anyone eligible for any obligation may deny it all.
        if not await self._eligible(approver, self._obligations(req)):
            raise RequestError([f"'{approver}' is not authorized to deny request '{request_id}'"])
        # A provisioned policy must be torn down before the request goes terminal, or the DB claims it is gone while IAM still has it.
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
        """Would approve() accept `approver` now? Fails closed."""
        req = await self._store.get(request_id)
        if req is None or req.status != RequestStatus.PENDING:
            return False
        if any(a["approver"] == approver for a in req.approvals):
            return False
        try:
            return bool(await self._eligible(approver, self._unmet(req, self._obligations(req))))
        except Exception:
            return False

    # --- retrieve / refresh / revoke (agent) -------------------------------
    async def status(
        self, *, request_id: str, conversation_id: str
    ) -> tuple[PermissionRequest | None, StsCredentials | None]:
        req = await self._store.get_for_conversation(request_id, conversation_id)
        if req is None:
            return None, None
        if req.status != RequestStatus.ACTIVE:
            return req, None
        creds = self._creds.get(request_id)
        # The STS token expires long before the role does and the cache is per pod, so a stale or missing token is re-minted from the DB while the role TTL holds.
        if creds is None or self._creds_stale(creds):
            if req.role_expires_at and req.role_expires_at <= _now():
                return req, None  # the role TTL has passed, so the agent must re-request
            try:
                _, creds = await self.refresh(request_id=request_id, conversation_id=conversation_id)
            except RequestError:
                return req, None
        return req, creds

    def _creds_stale(self, creds: StsCredentials) -> bool:
        """True if the STS token is expired or within the refresh skew window."""
        if not creds.expires_at:
            return False
        try:
            exp = datetime.fromisoformat(creds.expires_at)
        except ValueError:
            return True  # an unparseable expiry counts as stale
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        return exp <= datetime.now(timezone.utc) + timedelta(seconds=_CREDS_REFRESH_SKEW)

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
        # The teardown must succeed before the request goes terminal, because a terminal status is never swept again.
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
            # Only a successful teardown marks the request EXPIRED; otherwise it stays non-terminal so the next sweep retries it.
            if req.iam_role_arn and not self._iam.delete_dynamic_role(
                target_account=req.target_account, role_arn=req.iam_role_arn, policy_arn=req.iam_policy_arn,
            ):
                # Past the grace window a permanently failing teardown is forced to EXPIRED so the request stops looking active.
                if self._creds_expired_beyond_grace(req):
                    logger.warning(
                        "force-expiring request; IAM teardown failing but creds lapsed past grace "
                        "(role may be orphaned until teardown permissions are restored)",
                        extra={
                            "conversation_id": req.conversation_id,
                            "request_id": req.request_id,
                            "target_account": req.target_account,
                            "role_arn": req.iam_role_arn,
                            "grace_hours": _FORCE_EXPIRE_GRACE_HOURS,
                        },
                    )
                    self._creds.pop(req.request_id, None)
                    await self._store.update(req.request_id, status=RequestStatus.EXPIRED)
                    swept.append(req.request_id)
                    continue
                logger.error(
                    "IAM teardown failed during sweep; leaving non-terminal for retry",
                    extra={
                        "conversation_id": req.conversation_id,
                        "request_id": req.request_id,
                        "target_account": req.target_account,
                        "role_arn": req.iam_role_arn,
                    },
                )
                continue
            self._creds.pop(req.request_id, None)
            await self._store.update(req.request_id, status=RequestStatus.EXPIRED)
            swept.append(req.request_id)
        return swept

    def _creds_expired_beyond_grace(self, req: PermissionRequest) -> bool:
        """True if this request's STS creds lapsed more than the force-expire grace window ago."""
        if not req.expires_at:
            return False
        try:
            exp = datetime.fromisoformat(req.expires_at)
        except ValueError:
            return False
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        return exp + timedelta(hours=_FORCE_EXPIRE_GRACE_HOURS) < datetime.now(timezone.utc)

    async def list_for_conversation(self, conversation_id: str) -> list[PermissionRequest]:
        """The caller's own requests."""
        return await self._store.list_for_conversation(conversation_id)

    async def query_audit(self, **filters) -> list[PermissionRequest]:
        return await self._store.query_audit(**filters)

    def _duration_for(self, risk: RiskLevel) -> int:
        return {
            RiskLevel.LOW: self._config.duration_low,
            RiskLevel.MEDIUM: self._config.duration_medium,
            RiskLevel.HIGH: self._config.duration_high,
        }[risk]
