"""Permission service — orchestrates the request lifecycle.

DESIGN BOILERPLATE. The transport (routes) is thin; this holds the logic so it's
testable against a fake IAM provisioner + in-memory store. Wires together:
policy guardrails + store + IamProvisioner + the in-memory credential cache.

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

from dataclasses import dataclass

from .iam import IamProvisioner
from .models import PermissionRequest, RequestStatus, RiskLevel, StsCredentials
from .store import PermissionStore


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
    ) -> None:
        raise NotImplementedError

    # --- account discovery -------------------------------------------------
    def accounts(self) -> dict[str, dict]:
        """Enabled accounts + their bounds, so the agent learns its limits
        before crafting a policy. (allowed_policy summarized, not raw secrets.)"""
        raise NotImplementedError

    # --- request (agent) ---------------------------------------------------
    def request(
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
        """Validate (account enabled; managed ARNs allowlisted; inline policy
        through all 3 guardrail layers), classify risk, eagerly create the inline
        policy (so errors surface now), store `pending`. Raises RequestError on
        any guardrail failure (nothing is provisioned)."""
        raise NotImplementedError

    # --- approve / deny (approver) ----------------------------------------
    def approve(self, *, request_id: str, approver: str) -> PermissionRequest:
        """pending → approved → (provision dynamic role + cache creds) → active.
        Sets role_expires_at = now + role_ttl_hours. On IAM failure → error."""
        raise NotImplementedError

    def deny(self, *, request_id: str, approver: str, reason: str | None = None) -> PermissionRequest:
        """pending → denied; deletes the eagerly-created inline policy."""
        raise NotImplementedError

    # --- retrieve / refresh / revoke (agent) -------------------------------
    def status(self, *, request_id: str, conversation_id: str) -> tuple[PermissionRequest, StsCredentials | None]:
        """The request (isolated to its conversation) + cached creds iff active."""
        raise NotImplementedError

    def refresh(self, *, request_id: str, conversation_id: str) -> tuple[PermissionRequest, StsCredentials]:
        """Re-assume the live role for fresh creds (within role TTL). Fails if the
        role TTL has passed (re-approval required)."""
        raise NotImplementedError

    def revoke(self, *, request_id: str, conversation_id: str) -> PermissionRequest:
        """Self-revoke: tear down role+policy, clear cached creds, → revoked."""
        raise NotImplementedError

    # --- lifecycle sweep (background) -------------------------------------
    def sweep_expired(self) -> list[str]:
        """Tear down roles past role_expires_at, → expired. Returns the swept
        request_ids. Called on an interval by the broker."""
        raise NotImplementedError

    def _duration_for(self, risk: RiskLevel) -> int:
        """STS cred lifetime by risk (config)."""
        raise NotImplementedError
