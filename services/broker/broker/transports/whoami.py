"""whoami transport — the test/diagnostic transport.

Mounts `/{provider}/whoami`. Authenticates the caller exactly like every real
transport (SA token -> TokenReview -> Identity), records the call, and returns
the validated Identity to the caller. Delivers no real credential.

Purpose: end-to-end proof that a call reached the broker AND that the broker
authenticated the caller as the expected per-conversation identity (IRSA / SA).
Used by the dummy-agent e2e credential test.

Design stage: interface only.
"""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import APIRouter

from ..core.types import AuthDependency, Provider, Transport


@dataclass
class WhoAmI(Transport):
    recorder: object | None = None     # CallRecorder (records authed Identity)
    name: str = "whoami"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        """Mount GET /whoami: identity = await authed(request);
        recorder.record(identity); return identity as JSON
        {conversation_id, namespace, service_account}.
        """
        ...
