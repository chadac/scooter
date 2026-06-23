"""whoami transport — the test/diagnostic transport.

Mounts `/{provider}/whoami`. Authenticates the caller exactly like every real
transport (SA token -> TokenReview -> Identity), records the call, and returns
the validated Identity to the caller. Delivers no real credential.

Purpose: end-to-end proof that a call reached the broker AND that the broker
authenticated the caller as the expected per-conversation identity (IRSA / SA).
Used by the dummy-agent e2e credential test (`agent-broker test/whoami`).
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter, Depends

from ..core.types import AuthDependency, Identity, Provider, Transport


@dataclass
class WhoAmI(Transport):
    recorder: object | None = None     # CallRecorder (records authed Identity)
    name: str = "whoami"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        recorder = self.recorder

        @router.get("/whoami")
        async def whoami(identity: Identity = Depends(authed)) -> dict[str, str]:
            if recorder is not None and hasattr(recorder, "record"):
                recorder.record(identity)  # type: ignore[attr-defined]
            return {
                "conversation_id": identity.conversation_id,
                "namespace": identity.namespace,
                "service_account": identity.service_account,
            }

        return router
