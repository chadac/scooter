"""AWS permissions broker: data model and lifecycle states (see docs/AWS_PERMISSIONS_BROKER.md)."""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any


class RequestStatus(str, enum.Enum):
    """Permission-request lifecycle: pending, approved, active, expired, with branches to denied, revoked, superseded and error."""

    PENDING = "pending"
    APPROVED = "approved"   # dynamic IAM role being created
    ACTIVE = "active"       # role ready, STS credentials available
    EXPIRED = "expired"     # role TTL elapsed, role deleted
    DENIED = "denied"
    REVOKED = "revoked"
    SUPERSEDED = "superseded"  # replaced by a newer request for the same (conversation, account)
    ERROR = "error"         # IAM provisioning failed


class RiskLevel(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass
class PermissionRequest:
    """One agent permission request, the durable record; `conversation_id` is the validated caller identity, not a body field."""

    request_id: str                       # 12-char id
    conversation_id: str
    target_account: str                   # account alias (registry key)
    justification: str
    status: RequestStatus = RequestStatus.PENDING
    risk_level: RiskLevel = RiskLevel.LOW

    policy_document: dict[str, Any] | None = None
    managed_policy_arns: list[str] = field(default_factory=list)
    policy_summary: str = ""

    conversation_url: str | None = None
    parent_request_id: str | None = None  # set for escalations

    requested_at: str = ""
    approved_at: str | None = None
    approved_by: str | None = None        # approver identity
    denied_at: str | None = None
    denied_by: str | None = None
    deny_reason: str | None = None
    revoked_at: str | None = None

    iam_role_arn: str | None = None
    iam_policy_arn: str | None = None
    role_expires_at: str | None = None    # role TTL, the refresh window

    # The STS credential itself is never persisted.
    credentials_issued_at: str | None = None
    expires_at: str | None = None

    # rules.Obligation JSON, fixed at request time; None on older requests.
    approval_obligations: list[dict[str, Any]] | None = None
    # {approver, approved_at, obligations} rows from aws_request_approvals.
    approvals: list[dict[str, Any]] = field(default_factory=list)


def obligation_status(req: PermissionRequest) -> list[dict[str, Any]]:
    """Each obligation with its approver, or None while waiting."""
    approvals = getattr(req, "approvals", None) or []
    out = []
    for o in getattr(req, "approval_obligations", None) or []:
        by = next((a["approver"] for a in approvals if o["id"] in a.get("obligations", [])), None)
        out.append({"id": o["id"], "rules": o["rules"], "parts": o.get("parts", []), "approved_by": by})
    return out


@dataclass
class StsCredentials:
    """Ephemeral STS credentials vended to the agent, held in memory only."""

    access_key_id: str
    secret_access_key: str
    session_token: str
    region: str
    expires_at: str


def approval_message(req: PermissionRequest) -> str:
    """The prose a human reads when asked to approve this request, shared by the notify and the pending-list view so a rebuilt window is worded the same."""
    lines = [
        f"Scooter is requesting AWS access to {req.target_account} "
        f"(risk: {req.risk_level.value}).",
    ]
    if req.policy_summary:
        lines.append(req.policy_summary)
    lines.append(f"Reason: {req.justification or '(none)'}")
    waiting = [", ".join(o["rules"]) for o in obligation_status(req) if o["approved_by"] is None]
    if getattr(req, "approvals", None) and waiting:
        lines.append(f"Still needs approval for: {'; '.join(waiting)}")
    return "\n".join(lines)


def decision_message(req: PermissionRequest) -> str | None:
    """What the agent is told once a human decides, or None while still pending."""
    if req.status == RequestStatus.ACTIVE:
        return (
            f"Your AWS request {req.request_id} for {req.target_account} was approved by "
            f"{req.approved_by or 'a human'}. The credentials are live: run "
            f"`aws --profile {req.target_account} ...`."
        )
    if req.status == RequestStatus.DENIED:
        reason = f" Reason: {req.deny_reason}" if req.deny_reason else ""
        return (
            f"Your AWS request {req.request_id} for {req.target_account} was denied by "
            f"{req.denied_by or 'a human'}.{reason} Don't re-request the same scope; "
            "ask the user how to proceed."
        )
    return None


APPROVAL_KIND = "aws.permissions"


def approval_data(req: PermissionRequest) -> dict[str, Any]:
    """The full request for the approval UI's `aws.permissions` card, beside the prose."""
    # Deferred: policy imports this module for RiskLevel.
    from .policy import write_actions

    policy = getattr(req, "policy_document", None)
    return {
        "account": req.target_account,
        "risk": req.risk_level.value,
        "justification": req.justification,
        "summary": req.policy_summary,
        "policy_document": policy,
        "managed_policy_arns": list(getattr(req, "managed_policy_arns", None) or []),
        # The broker's own read/write rule, so the UI never re-derives it.
        "write_actions": write_actions(policy) if policy else [],
        "requested_at": getattr(req, "requested_at", "") or None,
        "parent_request_id": getattr(req, "parent_request_id", None),
        "obligations": obligation_status(req),
    }
