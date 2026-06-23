"""Echo (test) provider — a built-in provider for end-to-end credential-path
testing, driven through the UI.

It carries no real secret. Its `whoami` transport authenticates the caller (the
SAME per-conversation SA-token / TokenReview path every real provider uses) and
returns the validated Identity, plus records the call. A dummy-agent
conversation can hit `/test/whoami` and the test asserts the broker confirmed
the right identity (conversation_id / service account / IRSA) — proving the full
UI -> agent -> pod -> broker -> back round-trip.

This is a real, shippable provider (gated to test/dev by config), so adding new
end-to-end credential tests later is just "have the agent call /test/...".

Design stage: factory + recorder shape only.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..core.registry import register_provider
from ..core.types import Identity, Provider
from ..transports.whoami import WhoAmI


@dataclass
class CallRecorder:
    """In-memory record of authenticated calls, for tests to assert against."""

    calls: list[Identity] = field(default_factory=list)

    def record(self, identity: Identity) -> None:
        ...


# Shared recorder the WhoAmI transport writes to and tests can read.
recorder = CallRecorder()


@register_provider
def echo() -> Provider:
    """The test provider. enabled only when config.test_provider_enabled."""
    return Provider(
        name="test",
        transports=[WhoAmI(recorder=recorder)],
        credential=None,  # no secret; whoami delivers none
        # config.test_provider_enabled — OFF in prod; on for dev/e2e.
        enabled=False,
    )
