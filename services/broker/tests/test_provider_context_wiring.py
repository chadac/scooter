"""The app must hand a BrokerContext to any factory that asks for one.

Arity dispatch (PR #624): a provider opts in by declaring a parameter, and
discover_providers REFUSES to build such a factory when no context is supplied —
correct, but the symptom is the provider simply ABSENT. Its routes 404, which reads
like "disabled" in a deployment that very much meant to enable it.

This used to be an aws test. aws is now a contrib (PR #599), and the app should not
reach into one to prove its own wiring — so it is asserted with a locally-registered
probe factory, which also keeps working for whatever the next context-taking provider
is. The consumer half — "the provider uses the authorizer it was given rather than
building one" — is tested in contrib/aws/tests/test_provider_wiring.py.

The probe registers through the real @register_provider (the registry is global and
the package scan exists only to trigger decoration), so create_app() discovers it by
exactly the path a shipped provider takes. It is popped again in teardown: a leaked
entry would mount a phantom provider in every later create_app() in this process.
"""

from __future__ import annotations

import pytest

from scooter_broker_lib import registry
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.transports.whoami import WhoAmI
from scooter_broker_lib.types import Provider


@pytest.fixture
def probe():
    seen: dict = {}

    @register_provider
    def ctx_probe(ctx: BrokerContext) -> Provider:
        seen["authorizer"] = ctx.authorizer
        seen["store_config"] = ctx.store_config
        return Provider(name="ctx-probe", transports=[WhoAmI()], enabled=True)

    assert "ctx_probe" in registry._REGISTRY, "the probe did not register"
    try:
        yield seen
    finally:
        registry._REGISTRY.pop("ctx_probe", None)


def test_a_context_taking_factory_is_built_and_mounted(probe):
    from broker.core.app import create_app

    app = create_app()

    assert probe, "the factory was skipped — the app supplied no BrokerContext"
    assert probe["authorizer"] is not None
    assert probe["store_config"] is not None

    # Mounted, not merely constructed. Asserted through the OpenAPI schema rather
    # than app.routes: this FastAPI keeps an included router as an opaque
    # `_IncludedRouter` in that list instead of flattening it into APIRoutes, so
    # scanning it for `.path` sees no provider routes at all — for a mounted
    # provider and an absent one alike, which is how such a check passes while
    # proving nothing.
    paths = app.openapi()["paths"]
    assert any(p.startswith("/ctx-probe/") for p in paths), f"mounted: {sorted(paths)}"


def test_the_authorizer_is_the_one_the_app_built(probe, monkeypatch):
    from broker.core import app as app_mod

    sentinel = object()
    # Patched where create_app LOOKS it up: it does `from .authz import
    # authorizer_from_settings` at import, so rebinding the core.authz original
    # would leave the already-bound name in core.app untouched.
    monkeypatch.setattr(app_mod, "authorizer_from_settings", lambda _s: sentinel)

    app_mod.create_app()
    assert probe["authorizer"] is sentinel
