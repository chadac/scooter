"""Core broker types: the contract provider modules, credential sources and transports implement.

A Provider is one integration, a credential Source (how the secret is obtained)
plus the Transports it offers (how it is delivered). The core discovers registered
providers and mounts every transport's routes, so adding an integration never
edits the core.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Awaitable, Callable, Protocol, runtime_checkable

import httpx
from fastapi import APIRouter

if TYPE_CHECKING:
    from .forge.policy import ForgePolicy, ForgeRequest

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Identity (who is calling)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Identity:
    """The caller identity the core extracted from a projected ServiceAccount token it validated via TokenReview."""

    conversation_id: str          # from the SA name sandbox-{conversation_id}
    namespace: str
    service_account: str          # system:serviceaccount:{ns}:sandbox-{id}
    # True for a configured approver (which has no conversation_id), not a sandbox.
    is_approver: bool = False
    # The conversation's owner from the conversation token's `owner` claim; a sandbox SA carries none, so it stays None there.
    owner: str | None = None
    # The signed-in user a settings tab acts for, named by the agent-host's /contrib-api
    # relay. Set only when the caller authenticated as a USER_RELAY_SERVICE_ACCOUNTS
    # account; from any other caller the header is ignored, so this stays None.
    relayed_user: str | None = None
    # A system task run by the scheduler (SYSTEM_TASK_SERVICE_ACCOUNTS), which a contrib's
    # /system routes require through `scooter_broker_lib.system.system_task_identity`.
    is_system_task: bool = False


# ---------------------------------------------------------------------------
# Credential (the obtained secret)
# ---------------------------------------------------------------------------

@dataclass
class Credential:
    """A resolved credential, ready for a transport to deliver."""

    kind: str                     # "bearer" | "basic" | "header" | "multi-header" | ...
    value: str                    # the secret, or for "multi-header" a JSON {name: value} map
    expires_at: float | None = None
    # Extra fields a transport may need, such as a git username.
    meta: dict[str, str] = field(default_factory=dict)

    def inject(self, req: httpx.Request) -> None:
        """Apply this credential to an outbound httpx request in place; a provider whose auth fits none of the shipped kinds overrides this."""
        # No secret means no header, so the upstream answers 401 rather than httpx rejecting "Bearer ".
        if self.kind in ("bearer", "basic", "header") and not self.value.strip():
            logger.warning("empty credential, sending no auth header", extra={"kind": self.kind, "host": req.url.host})
            return
        if self.kind == "bearer":
            req.headers["Authorization"] = f"Bearer {self.value}"
        elif self.kind == "header":
            name = self.meta.get("header_name", "Authorization")
            req.headers[name] = self.value
        elif self.kind == "basic":
            req.headers["Authorization"] = f"Basic {self.value}"
        elif self.kind == "multi-header":
            for name, val in json.loads(self.value or "{}").items():
                if val and val.strip():
                    req.headers[name] = val


@runtime_checkable
class CredentialSource(Protocol):
    """How a provider obtains its secret."""

    async def get(self, identity: Identity, request: "ForgeRequest | None" = None) -> Credential:
        """Resolve a credential for this caller; `request` is the forge call it is for, when known."""
        ...


# ---------------------------------------------------------------------------
# Transport (the injection method)
# ---------------------------------------------------------------------------

# A core-provided dependency that authenticates the request and returns the Identity.
AuthDependency = Callable[..., Awaitable[Identity]]


@runtime_checkable
class Transport(Protocol):
    """A delivery mechanism for a credential, which may mount several routes."""

    name: str

    def routes(self, provider: "Provider", authed: AuthDependency) -> APIRouter:
        """An APIRouter with this transport's routes for `provider`, mounted under its prefix unless `mount_at_root`."""
        ...

    # An optional `mcp_server` attribute (a `FastMCP`), discovered by `hasattr` so transports without tools still satisfy the Protocol, carries the agent tools served at the broker's /mcp endpoint.


# ---------------------------------------------------------------------------
# Provider (one integration = source + transports)
# ---------------------------------------------------------------------------

@dataclass
class Provider:
    """One integration: its credential source and the transports it offers."""

    name: str                          # registry key and route prefix
    transports: list[Transport]
    # Mount at "/" rather than "/<name>"; the transports then own their full paths.
    mount_at_root: bool = False
    # Optional because a diagnostic transport delivers no secret; transports that need one assert it at mount time.
    credential: CredentialSource | None = None
    enabled: bool = True
    # Optional hooks run by the app's lifespan.
    on_startup: Callable[[], Awaitable[None]] | None = None
    on_shutdown: Callable[[], Awaitable[None]] | None = None
    # Checked before the credential goes on any request to this provider's forge (forge/policy.py); None allows all.
    forge_policy: "ForgePolicy | None" = None
