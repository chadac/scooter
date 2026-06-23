"""Echo (test) provider — a built-in provider for end-to-end credential-path
testing, driven through the UI.

It carries no real secret. Its `whoami` transport authenticates the caller (the
SAME per-conversation SA-token / TokenReview path every real provider uses) and
returns the validated Identity, plus records the call. A dummy-agent
conversation can hit `/test/whoami` (via the in-pod `agent-broker` shim) and the
test asserts the broker confirmed the right identity (conversation_id / service
account / IRSA) — proving the full UI -> agent -> pod -> broker -> back trip.

Enabled only when config.test_provider_enabled (off in prod).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from ..config import settings
from ..core.registry import register_provider
from ..core.types import Identity, Provider
from ..transports.whoami import WhoAmI


@dataclass
class CallRecorder:
    """In-memory record of authenticated calls, for tests to assert against."""

    calls: list[Identity] = field(default_factory=list)

    def record(self, identity: Identity) -> None:
        self.calls.append(identity)


# Shared recorder the WhoAmI transport writes to and tests can read.
recorder = CallRecorder()


@register_provider
def echo() -> Provider:
    """The test provider. enabled only when config.test_provider_enabled."""
    return Provider(
        name="test",
        transports=[WhoAmI(recorder=recorder)],
        credential=None,  # no secret; whoami delivers none
        enabled=settings.test_provider_enabled,
    )
