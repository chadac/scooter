"""AWS permissions broker — data model + lifecycle states.

Ported from the OpenHands agent-token-broker, adapted to this repo's broker
(identity comes from the per-conversation SA token, not a shared API key +
session token). See docs/AWS_PERMISSIONS_BROKER.md.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass, field
from typing import Any


class RequestStatus(str, enum.Enum):
    """Permission-request lifecycle.

    pending → approved → active → expired, with branches → denied, → revoked,
    and approved → error (IAM provisioning failed).
    """

    PENDING = "pending"
    APPROVED = "approved"   # approved; dynamic IAM role being created
    ACTIVE = "active"       # role ready, STS credentials available
    EXPIRED = "expired"     # role TTL elapsed, role deleted
    DENIED = "denied"
    REVOKED = "revoked"
    ERROR = "error"         # IAM provisioning failed


class RiskLevel(str, enum.Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass
class PermissionRequest:
    """One agent permission request (the durable record).

    `conversation_id` is the validated caller identity (from the SA token), not
    a body field. `policy_document` is a free-form IAM policy and/or
    `managed_policy_arns` is a list of AWS managed-policy ARNs (at least one
    required). The IAM artifacts (role/policy ARNs) and STS expiry fill in as the
    request advances.
    """

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
    approved_by: str | None = None        # approver identity (email / SA / "user")
    denied_at: str | None = None
    denied_by: str | None = None
    deny_reason: str | None = None
    revoked_at: str | None = None

    # IAM artifacts.
    iam_role_arn: str | None = None
    iam_policy_arn: str | None = None
    role_expires_at: str | None = None    # role TTL (refresh window)

    # STS credential expiry (the cred itself is never persisted).
    credentials_issued_at: str | None = None
    expires_at: str | None = None


@dataclass
class StsCredentials:
    """Ephemeral STS credentials vended to the agent. Held in memory only —
    never written to the store."""

    access_key_id: str
    secret_access_key: str
    session_token: str
    region: str
    expires_at: str
