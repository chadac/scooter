"""Declarative policy: Scope -> Decision (RED-FIRST — see
todo/docs/EXTENSIBLE_BROKER.md).

The generic authorization tier. A deployer-supplied policy (mounted config) maps
scope patterns to ALLOW / REQUIRE_APPROVAL / DENY. Default posture is
ALLOW+audit for anything unconfigured, so today's blanket access is preserved
and deployers opt IN to tightening.
"""

from __future__ import annotations

import pytest

from broker.core.policy import Decision, DeclarativePolicy
from broker.core.scope import Scope
from broker.core.types import Identity


def _identity() -> Identity:
    return Identity(
        conversation_id="conv-1",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:sandbox-conv-1",
    )


async def test_unconfigured_scope_defaults_to_allow():
    # The critical no-breakage property: nothing configured -> ALLOW (+audit).
    policy = DeclarativePolicy.from_config({})
    d = await policy.decide(_identity(), Scope("github", "repo", "read"))
    assert d is Decision.ALLOW


async def test_explicit_default_deny_flips_the_posture():
    policy = DeclarativePolicy.from_config({"default": "deny"})
    d = await policy.decide(_identity(), Scope("github", "repo", "read"))
    assert d is Decision.DENY


async def test_exact_scope_rule_wins_over_default():
    policy = DeclarativePolicy.from_config(
        {"default": "allow", "rules": [{"scope": "github:repo:write", "decision": "require-approval"}]}
    )
    assert await policy.decide(_identity(), Scope("github", "repo", "write")) is Decision.REQUIRE_APPROVAL
    # a different action still rides the default
    assert await policy.decide(_identity(), Scope("github", "repo", "read")) is Decision.ALLOW


async def test_wildcard_scope_rule():
    # "*:*:admin" -> require approval for any provider's admin action.
    policy = DeclarativePolicy.from_config(
        {"default": "allow", "rules": [{"scope": "*:*:admin", "decision": "require-approval"}]}
    )
    assert await policy.decide(_identity(), Scope("s3", "bucket", "admin")) is Decision.REQUIRE_APPROVAL
    assert await policy.decide(_identity(), Scope("s3", "bucket", "read")) is Decision.ALLOW


async def test_deny_beats_require_approval_when_both_match():
    # Most-restrictive-wins: if two rules match a scope, DENY takes precedence.
    policy = DeclarativePolicy.from_config(
        {
            "default": "allow",
            "rules": [
                {"scope": "aws:*:*", "decision": "require-approval"},
                {"scope": "aws:s3:admin", "decision": "deny"},
            ],
        }
    )
    assert await policy.decide(_identity(), Scope("aws", "s3", "admin")) is Decision.DENY


def test_malformed_decision_raises_at_load():
    # A typo'd decision must fail loudly at config load, not silently allow.
    with pytest.raises(ValueError):
        DeclarativePolicy.from_config({"default": "allowe"})
