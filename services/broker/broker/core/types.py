"""Core broker types — the contract provider modules, credential sources, and
transports implement.

Design stage: interfaces / shapes only. No implementation.

Layering:
  Provider  = a credential SOURCE + the TRANSPORTS it offers (one integration)
  Transport = a delivery mechanism (http-proxy, git-credential, token-vend, ...)
  Source    = how the secret is obtained (GitHub App, static PAT, OAuth, ...)

The core auto-discovers registered providers and, for each, mounts every
transport's routes. Adding an integration never edits the core.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol, runtime_checkable

from fastapi import APIRouter


# ---------------------------------------------------------------------------
# Identity (who is calling)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Identity:
    """The validated caller identity, extracted from the pod's SA token.

    The pod presents a projected ServiceAccount token (audience agent-broker);
    the core validates it via K8s TokenReview and extracts this.
    """

    conversation_id: str          # from SA name sandbox-{conversation_id}
    namespace: str
    service_account: str          # full system:serviceaccount:{ns}:sandbox-{id}


# ---------------------------------------------------------------------------
# Credential (the obtained secret)
# ---------------------------------------------------------------------------

@dataclass
class Credential:
    """A resolved credential, ready for a transport to deliver."""

    kind: str                     # "bearer" | "basic" | "header" | ...
    value: str                    # the token / secret
    expires_at: float | None = None
    # Extra fields a transport may need (e.g. git username).
    meta: dict[str, str] = field(default_factory=dict)

    def inject(self, headers: dict[str, str]) -> dict[str, str]:
        """Apply this credential to outbound request headers (for http-proxy)."""
        if self.kind == "bearer":
            headers["Authorization"] = f"Bearer {self.value}"
        elif self.kind == "header":
            name = self.meta.get("header_name", "Authorization")
            headers[name] = self.value
        elif self.kind == "basic":
            headers["Authorization"] = f"Basic {self.value}"
        return headers


@runtime_checkable
class CredentialSource(Protocol):
    """How a provider obtains its secret. Pluggable per provider."""

    async def get(self, identity: Identity) -> Credential:
        """Resolve a credential for this caller (may mint/refresh/cache)."""
        ...


# ---------------------------------------------------------------------------
# Transport (the injection method)
# ---------------------------------------------------------------------------

# A core-provided dependency that authenticates the request and returns Identity.
AuthDependency = Callable[..., Awaitable[Identity]]


@runtime_checkable
class Transport(Protocol):
    """A delivery mechanism for a credential. Shipped: http-proxy,
    git-credential, token-vend. A transport may mount MULTIPLE routes.
    """

    name: str

    def routes(self, provider: "Provider", authed: AuthDependency) -> APIRouter:
        """Return an APIRouter with this transport's route(s) for `provider`,
        mounted under the provider's prefix by the core. Handlers use `authed`
        to get the Identity, then provider.credential.get(identity), then
        deliver per this transport's mechanism.
        """
        ...


# ---------------------------------------------------------------------------
# Provider (one integration = source + transports)
# ---------------------------------------------------------------------------

@dataclass
class Provider:
    """One integration. Owns its credential source and the transports it
    offers (each declaring its own config, e.g. upstream URL / git host).
    """

    name: str                          # registry key + route prefix
    transports: list[Transport]
    # The credential source. Optional: diagnostic transports (whoami) deliver no
    # secret. Transports that need one assert it at mount time.
    credential: CredentialSource | None = None
    enabled: bool = True
