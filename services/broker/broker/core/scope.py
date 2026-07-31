"""Scope — the generic permission unit + the core's default classifier.

A Scope is `(provider, resource, action)`, rendered canonically as
`"<provider>:<resource>:<action>"`. The generic authorization tier maps a Scope
to a Decision (see policy.py). A provider MAY ship its own ScopeClassifier for a
finer/path-based mapping; absent that, the core uses DefaultMethodScopeClassifier
(a coarse HTTP-method map). Content-dependent decisions that a scope triple can't
express (an IAM policy document, an email recipient allow-list) go through a
ProviderAuthorizer instead (see authz_provider.py).

See todo/docs/EXTENSIBLE_BROKER.md.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable


@dataclass(frozen=True)
class Scope:
    """One permission unit. Frozen + hashable so it can key a policy map. The
    `provider` is always the MOUNTING provider (core-supplied), never derived from
    the request — a caller can't spoof another provider's scope."""

    provider: str
    resource: str
    action: str  # convention: read | write | admin (providers may extend)

    def __str__(self) -> str:
        return f"{self.provider}:{self.resource}:{self.action}"


@runtime_checkable
class ScopeClassifier(Protocol):
    """Maps an inbound request to the Scope it requires. The core wraps every
    provider route; a provider's classifier only reports WHAT scope a request
    needs — it never makes the allow/deny call itself."""

    def scope_for(self, method: str, path: str, body: bytes | None) -> Scope: ...


# The coarse default: HTTP verb -> action. Reads (GET/HEAD) are "read"; mutations
# (POST/PUT/PATCH) are "write"; DELETE is "admin". A provider that needs finer
# granularity (per-path, per-body) ships its own ScopeClassifier.
_METHOD_ACTION = {
    "GET": "read",
    "HEAD": "read",
    "OPTIONS": "read",
    "POST": "write",
    "PUT": "write",
    "PATCH": "write",
    "DELETE": "admin",
}


@dataclass
class DefaultMethodScopeClassifier:
    """Default classifier: `provider` is fixed at mount (authoritative), the
    resource is a coarse constant, and the action is the HTTP-method map above."""

    provider: str
    resource: str = "api"

    def scope_for(self, method: str, path: str, body: bytes | None) -> Scope:
        action = _METHOD_ACTION.get(method.upper(), "write")
        return Scope(provider=self.provider, resource=self.resource, action=action)
