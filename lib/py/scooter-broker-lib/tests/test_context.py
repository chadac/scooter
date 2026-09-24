"""A factory gets the substrate iff it asks for it — and never silently gets none.

The registry decides by ARITY, so the nine factories that take no parameter had to
keep working untouched when the context was added; that is the property worth pinning,
along with the refusal that stops a context-wanting provider from being built with no
authorizer (which, since NoopAuthorizer allows everything, would look identical to a
working deployment while enforcing nothing).
"""

from __future__ import annotations

import sys
import types

import pytest

from scooter_broker_lib import registry
from scooter_broker_lib.authz import NoopAuthorizer
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.store import StoreConfig
from scooter_broker_lib.types import Provider


@pytest.fixture(autouse=True)
def _clean_registry():
    saved = dict(registry._REGISTRY)
    registry._REGISTRY.clear()
    yield
    registry._REGISTRY.clear()
    registry._REGISTRY.update(saved)


def _ctx() -> BrokerContext:
    return BrokerContext(authorizer=NoopAuthorizer(), store_config=StoreConfig())


def _empty_package(name: str) -> types.ModuleType:
    """A package with no modules, so discovery scans nothing but the registry."""
    mod = types.ModuleType(name)
    mod.__path__ = []
    sys.modules[name] = mod
    return mod


def test_zero_arg_factory_is_called_with_no_arguments():
    @registry.register_provider
    def plain() -> Provider:
        return Provider(name="plain", transports=[], enabled=True)

    assert not registry.wants_context(plain)
    built = registry.discover_providers([_empty_package("_t_plain")], context=_ctx())
    assert [p.name for p in built] == ["plain"]


def test_zero_arg_factory_works_with_no_context_at_all():
    # The pre-context call shape: a contrib's own test does exactly this.
    @registry.register_provider
    def plain() -> Provider:
        return Provider(name="plain", transports=[], enabled=True)

    assert [p.name for p in registry.discover_providers([_empty_package("_t_plain2")])] == ["plain"]


def test_factory_declaring_a_parameter_receives_the_context():
    seen: list[BrokerContext] = []

    @registry.register_provider
    def needs(ctx: BrokerContext) -> Provider:
        seen.append(ctx)
        return Provider(name="needs", transports=[], enabled=True)

    assert registry.wants_context(needs)
    ctx = _ctx()
    registry.discover_providers([_empty_package("_t_needs")], context=ctx)
    assert seen == [ctx]


def test_context_wanting_factory_is_absent_rather_than_unauthorized(caplog):
    """No context -> the provider does not build. It must never be built with none:
    NoopAuthorizer allows everything, so an unenforced provider looks healthy."""

    @registry.register_provider
    def needs(ctx: BrokerContext) -> Provider:  # pragma: no cover - must not run
        raise AssertionError("factory was called without a context")

    built = registry.discover_providers([_empty_package("_t_needs2")])
    assert built == []
    assert "FAILED to build" in caplog.text
