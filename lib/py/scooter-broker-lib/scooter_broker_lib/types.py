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

import json
from dataclasses import dataclass, field
from typing import Awaitable, Callable, Protocol, runtime_checkable

import httpx
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
    # True if this caller is a configured APPROVER (e.g. the agent-host relaying a
    # user's approve/deny), not a sandbox. Approvers have no conversation_id.
    is_approver: bool = False
    # The Scooter user who owns the conversation, when the caller's credential says
    # so. Only the MCP two-token path populates it (from the conversation token's
    # `owner` claim) — a sandbox SA name carries no owner, so this stays None there
    # rather than being guessed. A tool that must scope by owner reads this instead
    # of asking the agent-host. See issue #700.
    owner: str | None = None


# ---------------------------------------------------------------------------
# Credential (the obtained secret)
# ---------------------------------------------------------------------------

@dataclass
class Credential:
    """A resolved credential, ready for a transport to deliver."""

    kind: str                     # "bearer" | "basic" | "header" | "multi-header" | ...
    value: str                    # the token / secret ("multi-header": a JSON {name: value} map)
    expires_at: float | None = None
    # Extra fields a transport may need (e.g. git username).
    meta: dict[str, str] = field(default_factory=dict)

    def inject(self, req: httpx.Request) -> None:
        """Apply this credential to an OUTBOUND httpx request, in place.

        Takes the built request (not just a header dict) so a credential can
        mutate whatever it needs — headers, and in future query params / body /
        URL. A provider whose auth doesn't fit the shipped kinds subclasses
        Credential and overrides this. The shipped kinds mutate headers only:
          bearer        -> Authorization: Bearer <value>
          header        -> <meta.header_name>: <value>        (e.g. PRIVATE-TOKEN)
          basic         -> Authorization: Basic <value>
          multi-header  -> each {name: value} in the JSON `value` map (e.g. the
                           two Datadog keys DD-API-KEY / DD-APPLICATION-KEY)
        """
        if self.kind == "bearer":
            req.headers["Authorization"] = f"Bearer {self.value}"
        elif self.kind == "header":
            name = self.meta.get("header_name", "Authorization")
            req.headers[name] = self.value
        elif self.kind == "basic":
            req.headers["Authorization"] = f"Basic {self.value}"
        elif self.kind == "multi-header":
            for name, val in json.loads(self.value).items():
                req.headers[name] = val


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
    git-credential, token-vend, mcp-tools. A transport may mount MULTIPLE routes.
    """

    name: str

    def routes(self, provider: "Provider", authed: AuthDependency) -> APIRouter:
        """Return an APIRouter with this transport's route(s) for `provider`,
        mounted under the provider's prefix by the core. Handlers use `authed`
        to get the Identity, then provider.credential.get(identity), then
        deliver per this transport's mechanism.
        """
        ...

    # OPTIONAL second half: `mcp_server`, a `FastMCP` carrying the agent tools this
    # transport contributes. Served by the broker's single /mcp endpoint rather than
    # mounted under the provider's prefix, and mounted NAMESPACE-LESS so tool names
    # stay flat.
    #
    # Discovered by `hasattr` rather than declared in the Protocol's required surface:
    # adding it there would make every existing transport fail isinstance(), which is
    # why the four shipped transports that have no tools needed no change. The same
    # arity-not-a-flag reasoning as `registry.wants_context`.
    #
    # See scooter_broker_lib/mcp.py and transports/mcp_tools.py. Why: issue #700.


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
    # Optional async startup/shutdown hooks (e.g. open a DB, start a sweep task).
    # Run by the app's lifespan. Default: no-ops.
    on_startup: Callable[[], Awaitable[None]] | None = None
    on_shutdown: Callable[[], Awaitable[None]] | None = None
