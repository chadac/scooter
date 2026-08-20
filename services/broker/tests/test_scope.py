"""Scope + the core's default scope classifier (RED-FIRST — see
todo/docs/EXTENSIBLE_BROKER.md).

A Scope is the generic permission unit: (provider, resource, action). The core
supplies a DEFAULT classifier (a coarse HTTP-method map) so a provider that
doesn't override still gets sane scopes; a provider MAY ship its own
ScopeClassifier for a finer or path-based mapping.

These pin the generic path only. Content-dependent decisions (AWS IAM policy
docs, an email recipient allow-list) go through ProviderAuthorizer instead — see
test_provider_authorizer.py.
"""

from __future__ import annotations

import pytest

from broker.core.scope import Scope, DefaultMethodScopeClassifier


def test_scope_canonical_string():
    s = Scope(provider="github", resource="repo", action="write")
    assert str(s) == "github:repo:write"


def test_scope_is_frozen_hashable():
    # Scopes are used as policy-map keys → must be hashable + value-equal.
    a = Scope("github", "repo", "read")
    b = Scope("github", "repo", "read")
    assert a == b
    assert len({a, b}) == 1


@pytest.mark.parametrize(
    "method,expected_action",
    [
        ("GET", "read"),
        ("HEAD", "read"),
        ("POST", "write"),
        ("PUT", "write"),
        ("PATCH", "write"),
        ("DELETE", "admin"),
    ],
)
def test_default_classifier_maps_method_to_action(method, expected_action):
    c = DefaultMethodScopeClassifier(provider="github")
    scope = c.scope_for(method=method, path="/repos/o/r/issues", body=None)
    assert scope.provider == "github"
    assert scope.action == expected_action


def test_default_classifier_provider_is_authoritative():
    # The provider on the scope is the MOUNTING provider (core-supplied), never
    # derived from the request — a caller can't spoof another provider's scope.
    c = DefaultMethodScopeClassifier(provider="slack")
    assert c.scope_for(method="POST", path="/whatever", body=b"{}").provider == "slack"
