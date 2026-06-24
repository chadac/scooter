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
from ..sources.static_token import StaticTokenSource
from ..transports.git_credential import GitCredential
from ..transports.whoami import WhoAmI

# A deterministic fake git credential the test provider vends, so the full
# `git clone` / `git-credential-broker` path can be exercised end-to-end without
# a real GitHub App. The host is a sentinel that maps to the `test` provider via
# GIT_BROKER_HOST_MAP in the sandbox.
TEST_GIT_HOST = "test-git.local"
TEST_GIT_USERNAME = "test-user"
TEST_GIT_PASSWORD = "test-broker-token"  # noqa: S105 (fake, test-only)


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
    """The test provider. enabled only when config.test_provider_enabled.

    Carries two transports: `whoami` (identity echo) and `git-credential` (vends
    a fixed fake credential for TEST_GIT_HOST) so the broker-backed git auth path
    is testable end-to-end. Both still go through the same SA-token/TokenReview
    auth as every real provider.
    """
    return Provider(
        name="test",
        transports=[
            WhoAmI(recorder=recorder),
            GitCredential(host=TEST_GIT_HOST, username=TEST_GIT_USERNAME),
        ],
        # Fixed fake token, so /test/git-credentials returns it for an
        # authenticated caller.
        credential=StaticTokenSource(token=TEST_GIT_PASSWORD),
        enabled=settings.test_provider_enabled,
    )
