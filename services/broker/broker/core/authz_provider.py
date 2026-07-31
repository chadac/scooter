"""ProviderAuthorizer — the custom-authz hook for content-dependent decisions.

The generic tier (scope_for -> DeclarativePolicy) covers proxy providers with
zero provider code. But some providers' permission unit is a constraint over
request CONTENT the core can't interpret from a scope triple:

  - AWS: the unit is an IAM policy document (actions x resource ARNs x conditions)
    carried in the body, vended as time-boxed STS creds — not a REST verb+path.
  - Email: "send only to @company.com" is a check over the recipients in the body.

Such a provider ships a ProviderAuthorizer. Its `authorize()` returns an
AuthzResult(decision, scope, summary, detail) — the core still owns audit + the
approval interrupt; the provider supplies only the JUDGMENT + a human render, and
an optional `on_approved()` side-effect (AWS mints STS; email does nothing).

The deployer's policy config is PASSED INTO authorize() (providers enforce
policy, they don't own it) so all constraints stay reviewable in one place.

See todo/docs/EXTENSIBLE_BROKER.md.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

from .policy import Decision
from .types import Identity


@dataclass
class InboundRequest:
    """The parts of the inbound request a ProviderAuthorizer inspects. A plain
    value (not the raw Starlette Request) so the hook is easy to unit-test and the
    core controls exactly what's exposed. `body` is the raw bytes (already
    buffered by the middleware)."""

    method: str
    path: str
    body: bytes | None = None


@dataclass
class AuthzResult:
    """A provider's authorization verdict. `scope` + `summary` + `detail` feed
    audit and (on REQUIRE_APPROVAL) the approval interrupt. NEVER a credential or
    the raw body — `detail` is provider metadata only (recipients, policy ARNs)."""

    decision: Decision
    scope: str
    summary: str
    detail: dict | None = field(default=None)


@runtime_checkable
class ProviderAuthorizer(Protocol):
    """A provider MAY implement this. Absent -> the core's generic path
    (scope_for -> DeclarativePolicy). `on_approved` is optional (checked with
    hasattr by the core); a provider that needs no approve-time side-effect omits
    it."""

    async def authorize(self, identity: Identity, req: InboundRequest, policy: dict) -> AuthzResult: ...
