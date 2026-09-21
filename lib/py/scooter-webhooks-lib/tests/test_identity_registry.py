"""Owner resolution is a REGISTRY, not a dispatch chain.

The chain it replaces (`if provider == "slack" / "github" / "gitlab"`) could only
grow by editing the lib, which is what kept three provider API clients inside the
shared surface. Why: PR #575.
"""

from __future__ import annotations

import pytest

from scooter_webhooks_lib import agent_host_client, identity

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _clean_registry():
    saved = dict(identity._resolvers)
    identity._resolvers.clear()
    yield
    identity._resolvers.clear()
    identity._resolvers.update(saved)


async def test_an_unregistered_provider_resolves_to_nothing():
    # Not an error: a deployment that doesn't ship gitlab simply has no gitlab owner
    # lookup, and the conversation stays unowned.
    assert await identity.get_user_email("gitlab", "alice") is None
    assert await identity.resolve_owner("gitlab", "alice") is None


async def test_a_registered_resolver_is_used():
    @identity.register_email_resolver("acme")
    async def _resolve(external_id: str) -> str | None:
        return f"{external_id}@acme.test"

    assert await identity.get_user_email("acme", "bob") == "bob@acme.test"
    assert identity.registered_providers() == ["acme"]


async def test_re_registering_replaces_so_a_contrib_can_override():
    @identity.register_email_resolver("acme")
    async def _first(external_id: str) -> str | None:
        return "first@acme.test"

    @identity.register_email_resolver("acme")
    async def _second(external_id: str) -> str | None:
        return "second@acme.test"

    assert await identity.get_user_email("acme", "bob") == "second@acme.test"


async def test_a_raising_resolver_cannot_break_the_webhook_path():
    # Third-party contrib code. A best-effort ownership lookup must not turn a
    # delivery into a 500.
    @identity.register_email_resolver("acme")
    async def _boom(external_id: str) -> str | None:
        raise RuntimeError("provider API exploded")

    assert await identity.get_user_email("acme", "bob") is None
    assert await identity.resolve_owner("acme", "bob") is None


async def test_the_client_refuses_to_run_unconfigured(monkeypatch):
    # The guard that makes "config is injected" safe: skipping init() must fail
    # loudly here, not as a confusing connection error on the first delivery.
    monkeypatch.setattr(agent_host_client, "_config", None)
    with pytest.raises(RuntimeError, match="init"):
        agent_host_client.conversation_url("conv-1")
