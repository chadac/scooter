"""Echo broker provider — the broker half of the reference contrib.

Registered into the broker via the ``agent_broker.providers`` entry point
(see pyproject.toml). The broker imports this module only when it loads that
entry-point group, so ``broker.*`` is guaranteed present at import time — a
contrib never needs to depend on the broker package itself.

The provider mounts a self-contained ``/echo/ping`` transport that
authenticates the caller exactly like every real transport (SA token ->
TokenReview -> Identity) and echoes the validated identity back. It carries no
real secret. This demonstrates the full extension seam — a custom Transport,
a Provider factory, and entry-point discovery — without touching broker core.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, Depends

from broker.core.registry import register_provider
from broker.core.types import AuthDependency, Identity, Provider, Transport

PROVIDER_NAME = "echo"


@dataclass
class EchoTransport(Transport):
    """Minimal example transport: one authenticated route that echoes identity.

    A real transport delivers a credential (http-proxy, git-credential, …); this
    one delivers nothing, proving only that a contrib can define and mount its
    own transport type. Mounted by the core under ``/{provider.name}``.
    """

    name: str = "echo"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()

        @router.get("/ping")
        async def ping(identity: Identity = Depends(authed)) -> dict[str, str]:
            return {
                "provider": provider.name,
                "conversation_id": identity.conversation_id,
                "pong": "echo",
            }

        return router


@register_provider
def echo_contrib() -> Provider:
    """Build the echo provider.

    A real contrib would gate ``enabled`` on its own config (an env var / secret
    presence), the way the built-in ``test`` provider gates on
    ``settings.test_provider_enabled``. This example is always enabled because it
    is only ever installed in test/example images, never the production broker.
    """
    return Provider(
        name=PROVIDER_NAME,
        transports=[EchoTransport()],
        credential=None,  # diagnostic transport: delivers no secret
        enabled=True,
    )
