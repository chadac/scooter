"""Declarative policy — the generic authorization tier: Scope -> Decision.

A deployer-supplied policy (a mounted config) maps scope patterns to a Decision.
The default posture is ALLOW (+audit) for anything unconfigured, so today's
blanket access is preserved and deployers opt IN to `require-approval` / `deny`.

When multiple rules match a scope, the MOST RESTRICTIVE wins
(DENY > REQUIRE_APPROVAL > ALLOW), so a broad `require-approval` can be tightened
to `deny` for a specific scope without ordering games.

Content-dependent decisions a scope pattern can't express go through a
ProviderAuthorizer (authz_provider.py); this is the generic path only.

See todo/docs/EXTENSIBLE_BROKER.md.
"""

from __future__ import annotations

from enum import Enum
from typing import Protocol, runtime_checkable

from .scope import Scope
from .types import Identity


class Decision(Enum):
    ALLOW = "allow"
    REQUIRE_APPROVAL = "require-approval"
    DENY = "deny"


# Restrictiveness order for "most-restrictive-wins" when several rules match.
_RANK = {Decision.ALLOW: 0, Decision.REQUIRE_APPROVAL: 1, Decision.DENY: 2}

# Accept the config's decision spellings (hyphen or underscore).
_DECISION_ALIASES = {
    "allow": Decision.ALLOW,
    "require-approval": Decision.REQUIRE_APPROVAL,
    "require_approval": Decision.REQUIRE_APPROVAL,
    "deny": Decision.DENY,
}


def _parse_decision(raw: str) -> Decision:
    try:
        return _DECISION_ALIASES[str(raw).strip().lower()]
    except KeyError as e:
        raise ValueError(
            f"invalid policy decision {raw!r} (want one of: "
            f"allow, require-approval, deny)"
        ) from e


def _pattern_matches(pattern: str, scope: Scope) -> bool:
    """A scope pattern is `<provider>:<resource>:<action>` where each segment is a
    literal or `*` (wildcard). Matches segment-wise against the scope."""
    parts = pattern.split(":")
    if len(parts) != 3:
        raise ValueError(f"invalid scope pattern {pattern!r} (want provider:resource:action)")
    seg = (scope.provider, scope.resource, scope.action)
    return all(p == "*" or p == s for p, s in zip(parts, seg))


@runtime_checkable
class Policy(Protocol):
    async def decide(self, identity: Identity, scope: Scope) -> Decision: ...


class DeclarativePolicy:
    """Config-driven scope->Decision policy. Build via `from_config(dict)`:

        {
          "default": "allow",                # unconfigured scope -> this (default allow)
          "rules": [
            {"scope": "github:repo:write", "decision": "require-approval"},
            {"scope": "*:*:admin",         "decision": "require-approval"},
            {"scope": "aws:s3:admin",      "decision": "deny"},
          ],
        }
    """

    def __init__(self, default: Decision, rules: list[tuple[str, Decision]]) -> None:
        self._default = default
        self._rules = rules

    @classmethod
    def from_config(cls, config: dict) -> "DeclarativePolicy":
        default = _parse_decision(config.get("default", "allow"))
        rules: list[tuple[str, Decision]] = []
        for r in config.get("rules", []) or []:
            pattern = r["scope"]
            _pattern_matches(pattern, Scope("_", "_", "_"))  # validate shape at load
            rules.append((pattern, _parse_decision(r["decision"])))
        return cls(default, rules)

    async def decide(self, identity: Identity, scope: Scope) -> Decision:
        matched = [d for pat, d in self._rules if _pattern_matches(pat, scope)]
        if not matched:
            return self._default
        # Most-restrictive-wins.
        return max(matched, key=lambda d: _RANK[d])
