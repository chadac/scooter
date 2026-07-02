"""IAM policy guardrails — validate, bound-check, classify, summarize.

The security core of the AWS permissions broker. Pure functions (no AWS), ported
faithfully from the OpenHands agent-token-broker. Three layers gate every
request:
  1. validate_policy        — structural + prod-account + deny-list checks
  2. (global deny list)     — BLOCKED_ACTIONS / BLOCKED_PATTERNS (in layer 1)
  3. validate_policy_within_bounds — per-account allowlist coverage

A permission BOUNDARY on every dynamic role is the AWS-enforced ceiling on top of
these application-level checks (see iam.py).
"""

from __future__ import annotations

import fnmatch
import re

from .models import RiskLevel

# --- Layer 2: global deny list (privilege escalation, audit/security tamper) ---
BLOCKED_ACTIONS: list[str] = [
    # IAM privilege escalation
    "iam:CreateUser",
    "iam:CreateRole",
    "iam:AttachRolePolicy",
    "iam:DetachRolePolicy",
    "iam:PutRolePolicy",
    "iam:DeleteRolePolicy",
    "iam:CreateAccessKey",
    "iam:UpdateAssumeRolePolicy",
    "iam:PutRolePermissionsBoundary",
    "iam:DeleteRolePermissionsBoundary",
    "iam:PassRole",
    # Security/audit tampering
    "cloudtrail:DeleteTrail",
    "cloudtrail:StopLogging",
    "cloudtrail:UpdateTrail",
    "guardduty:DeleteDetector",
    "guardduty:DeleteMembers",
    "guardduty:DisassociateFromMasterAccount",
    "securityhub:DeleteHub",
    "securityhub:DisableSecurityHub",
    "config:DeleteConfigRule",
    "config:DeleteConfigurationRecorder",
    "config:StopConfigurationRecorder",
    # Organization
    "organizations:LeaveOrganization",
    # Encryption
    "kms:ScheduleKeyDeletion",
    "kms:DisableKey",
    "kms:DeleteAlias",
    # Account
    "account:CloseAccount",
]

# Wildcard-pattern blocked actions (fnmatch, e.g. guardduty:Delete*).
BLOCKED_PATTERNS: list[str] = [
    "guardduty:Delete*",
    "guardduty:Disable*",
    "securityhub:Delete*",
    "securityhub:Disable*",
    "config:Delete*",
    "config:Stop*",
    "kms:Delete*",
]

READ_ONLY_PREFIXES = (
    "Get", "List", "Describe", "Head", "BatchGet",
    "Lookup", "Search", "Query", "Scan", "Select",
    "Check", "Detect", "Discover", "Fetch", "Preview",
    "Read", "Test", "Validate", "Verify",
)

MAX_STATEMENTS = 20


def _is_read_only_action(action: str) -> bool:
    parts = action.split(":", 1)
    if len(parts) != 2:
        return False
    verb = parts[1]
    return any(verb.startswith(prefix) for prefix in READ_ONLY_PREFIXES)


def _action_matches_blocked(action: str) -> str | None:
    """The matching blocked pattern if `action` is blocked, else None."""
    action_lower = action.lower()
    for blocked in BLOCKED_ACTIONS:
        if action_lower == blocked.lower():
            return blocked
    for pattern in BLOCKED_PATTERNS:
        if fnmatch.fnmatch(action_lower, pattern.lower()):
            return pattern
    return None


def _normalize_actions(actions: str | list[str]) -> list[str]:
    return [actions] if isinstance(actions, str) else actions


def _normalize_resources(resources: str | list[str]) -> list[str]:
    return [resources] if isinstance(resources, str) else resources


def _is_prod_account(target_account: str) -> bool:
    return any(m in target_account.lower() for m in ("production", "prod"))


def validate_policy(policy_document: dict, target_account: str = "") -> list[str]:
    """Layer 1+2: structural + deny-list + prod-account checks.

    Returns a list of error strings (empty = valid).
    """
    errors: list[str] = []
    is_prod = _is_prod_account(target_account)

    if policy_document.get("Version") != "2012-10-17":
        errors.append("Policy Version must be '2012-10-17'")

    statements = policy_document.get("Statement", [])
    if not statements:
        errors.append("Policy must contain at least one Statement")
        return errors

    if len(statements) > MAX_STATEMENTS:
        errors.append(f"Policy exceeds maximum of {MAX_STATEMENTS} statements")

    for i, stmt in enumerate(statements, 1):
        prefix = f"Statement {i}"

        effect = stmt.get("Effect", "")
        if effect != "Allow":
            errors.append(f"{prefix}: Only 'Allow' effect is supported (got '{effect}')")
            continue

        actions = _normalize_actions(stmt.get("Action", []))
        if not actions:
            errors.append(f"{prefix}: Action is required")
            continue

        resources = _normalize_resources(stmt.get("Resource", []))
        if not resources:
            errors.append(f"{prefix}: Resource is required")

        for action in actions:
            match = _action_matches_blocked(action)
            if match:
                errors.append(f"{prefix}: Action '{action}' is blocked (matches '{match}')")

        has_write = any(not _is_read_only_action(a) for a in actions)
        if has_write and is_prod:
            for resource in resources:
                if resource == "*":
                    errors.append(
                        f"{prefix}: Resource '*' is not allowed for write actions in "
                        "production. Specify explicit resource ARNs."
                    )

        for action in actions:
            if action == "*":
                errors.append(f"{prefix}: Action '*' (full wildcard) is not allowed")
            elif (
                is_prod
                and ":" in action
                and action.split(":")[1] == "*"
                and not _is_read_only_action(action)
            ):
                service = action.split(":")[0]
                errors.append(
                    f"{prefix}: Action '{action}' is too broad for production. "
                    f"Specify individual {service} actions."
                )

    return errors


def classify_risk(policy_document: dict, target_account: str) -> RiskLevel:
    """prod+write → HIGH; write or prod → MEDIUM; else LOW. Drives STS duration."""
    is_prod = _is_prod_account(target_account)
    has_write = False
    for stmt in policy_document.get("Statement", []):
        actions = _normalize_actions(stmt.get("Action", []))
        if any(not _is_read_only_action(a) for a in actions):
            has_write = True
            break
    if is_prod and has_write:
        return RiskLevel.HIGH
    if has_write or is_prod:
        return RiskLevel.MEDIUM
    return RiskLevel.LOW


def is_read_only_policy(policy_document: dict) -> bool:
    """True iff EVERY action in the policy is read-only (Get*/List*/Describe*/…),
    with at least one statement/action present. Used for opt-in auto-approval of
    read-only requests — a wildcard (`*` or `service:*`) is NOT read-only (it grants
    writes), so it fails this check and still needs a human. Deny statements are
    ignored (a Deny can't grant anything)."""
    saw_action = False
    for stmt in policy_document.get("Statement", []):
        if stmt.get("Effect", "Allow") != "Allow":
            continue
        actions = _normalize_actions(stmt.get("Action", []))
        for a in actions:
            saw_action = True
            if not _is_read_only_action(a):
                return False
    return saw_action


def validate_policy_within_bounds(policy_document: dict, allowed_policy: dict) -> list[str]:
    """Layer 3: every requested action+resource must be covered by the account's
    allowed_policy (same Statement structure, fnmatch patterns). An unrestricted
    account uses Action ["*"], Resource ["*"]."""
    allowed_stmts = allowed_policy.get("Statement", [])
    if not allowed_stmts:
        return ["Account has no allowed_policy statements — all requests denied"]

    errors: list[str] = []
    for i, stmt in enumerate(policy_document.get("Statement", []), 1):
        actions = _normalize_actions(stmt.get("Action", []))
        resources = _normalize_resources(stmt.get("Resource", []))
        for action in actions:
            if not _action_covered_by_bounds(action, resources, allowed_stmts):
                errors.append(
                    f"Statement {i}: Action '{action}' is not within the allowed "
                    "permissions for this account"
                )
    return errors


def _action_covered_by_bounds(action: str, resources: list[str], allowed_stmts: list[dict]) -> bool:
    for allowed_stmt in allowed_stmts:
        allowed_actions = _normalize_actions(allowed_stmt.get("Action", []))
        allowed_resources = _normalize_resources(allowed_stmt.get("Resource", []))
        if not _pattern_list_covers(allowed_actions, action):
            continue
        if all(_pattern_list_covers(allowed_resources, r) for r in resources):
            return True
    return False


def _pattern_list_covers(patterns: list[str], value: str) -> bool:
    """Case-insensitive fnmatch; "*" covers everything."""
    value_lower = value.lower()
    return any(fnmatch.fnmatch(value_lower, p.lower()) for p in patterns)


def summarize_policy(policy_document: dict) -> str:
    """A human-readable one-line summary of the policy (for the approval UI)."""
    parts: list[str] = []
    for stmt in policy_document.get("Statement", []):
        actions = _normalize_actions(stmt.get("Action", []))
        resources = _normalize_resources(stmt.get("Resource", []))
        action_str = ", ".join(actions[:3])
        if len(actions) > 3:
            action_str += f" (+{len(actions) - 3} more)"
        resource_names = []
        for r in resources[:3]:
            match = re.search(r"arn:aws:[^:]+:[^:]*:[^:]*:(.+)", r)
            resource_names.append(match.group(1) if match else r)
        resource_str = ", ".join(resource_names)
        if len(resources) > 3:
            resource_str += f" (+{len(resources) - 3} more)"
        parts.append(f"{action_str} on {resource_str}")
    return "; ".join(parts)
