"""The provider registry, with the packages to scan as a parameter."""

from __future__ import annotations

import sys
import types

import pytest

from scooter_broker_lib import registry
from scooter_broker_lib.registry import (
    ENTRY_POINT_GROUP,
    discover_providers,
    register_provider,
)
from scooter_broker_lib.types import Provider


@pytest.fixture(autouse=True)
def _isolated_registry():
    """@register_provider writes to module state, so isolate it per test."""
    saved = dict(registry._REGISTRY)
    registry._REGISTRY.clear()
    yield
    registry._REGISTRY.clear()
    registry._REGISTRY.update(saved)


def _package(name: str, modules: dict[str, str]):
    """Build an importable throwaway package on disk, since the scan walks __path__ with pkgutil."""
    import pathlib
    import tempfile

    root = pathlib.Path(tempfile.mkdtemp())
    pkg_dir = root / name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    for mod_name, source in modules.items():
        (pkg_dir / f"{mod_name}.py").write_text(source)
    sys.path.insert(0, str(root))
    try:
        return __import__(name)
    finally:
        pass


_PROVIDER_SOURCE = """
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider

@register_provider
def {factory}() -> Provider:
    return Provider(name="{name}", transports=[], enabled={enabled})
"""


def test_scans_the_packages_it_is_given(monkeypatch):
    pkg = _package(
        "scooter_test_builtins_a",
        {
            "alpha": _PROVIDER_SOURCE.format(factory="alpha", name="alpha", enabled=True),
            "beta": _PROVIDER_SOURCE.format(factory="beta", name="beta", enabled=True),
        },
    )
    monkeypatch.setattr(registry, "_load_entrypoint_providers", lambda: None)

    names = {p.name for p in discover_providers([pkg])}
    assert names == {"alpha", "beta"}


def test_scans_nothing_when_given_nothing(monkeypatch):
    monkeypatch.setattr(registry, "_load_entrypoint_providers", lambda: None)
    assert discover_providers() == []


def test_scans_more_than_one_package(monkeypatch):
    a = _package(
        "scooter_test_builtins_b",
        {"one": _PROVIDER_SOURCE.format(factory="one", name="one", enabled=True)},
    )
    b = _package(
        "scooter_test_builtins_c",
        {"two": _PROVIDER_SOURCE.format(factory="two", name="two", enabled=True)},
    )
    monkeypatch.setattr(registry, "_load_entrypoint_providers", lambda: None)

    assert {p.name for p in discover_providers([a, b])} == {"one", "two"}


def test_a_disabled_provider_is_left_out(monkeypatch):
    pkg = _package(
        "scooter_test_builtins_d",
        {
            "on": _PROVIDER_SOURCE.format(factory="on", name="on", enabled=True),
            "off": _PROVIDER_SOURCE.format(factory="off", name="off", enabled=False),
        },
    )
    monkeypatch.setattr(registry, "_load_entrypoint_providers", lambda: None)

    assert {p.name for p in discover_providers([pkg])} == {"on"}


def test_a_factory_that_raises_is_skipped_loudly(monkeypatch, caplog):
    # A bad provider is absent, which reads like "disabled" unless the log says otherwise.
    @register_provider
    def exploding() -> Provider:
        raise RuntimeError("bad config")

    @register_provider
    def healthy() -> Provider:
        return Provider(name="healthy", transports=[])

    monkeypatch.setattr(registry, "_load_entrypoint_providers", lambda: None)

    with caplog.at_level("ERROR"):
        providers = discover_providers()

    assert {p.name for p in providers} == {"healthy"}
    assert "ABSENT" in caplog.text
    assert any(getattr(r, "provider", None) == "exploding" for r in caplog.records)


def test_register_provider_keys_on_the_factory_name():
    @register_provider
    def my_provider() -> Provider:
        return Provider(name="routed-as-this", transports=[])

    assert "my_provider" in registry._REGISTRY


def test_register_provider_takes_an_explicit_name_as_a_decorator():
    @register_provider(name="databricks-prod")
    def factory() -> Provider:
        return Provider(name="databricks-prod", transports=[])

    assert registry._REGISTRY["databricks-prod"] is factory
    assert "factory" not in registry._REGISTRY


def test_register_provider_takes_an_explicit_name_in_the_call_form(monkeypatch):
    # The case a contrib serving one provider per configured workspace hits: one closure, many names.
    def make(workspace: str):
        return lambda: Provider(name=f"databricks-{workspace}", transports=[])

    for workspace in ("prod", "dev"):
        register_provider(make(workspace), name=f"databricks-{workspace}")
    monkeypatch.setattr(registry, "_load_entrypoint_providers", lambda: None)

    assert {p.name for p in discover_providers()} == {"databricks-prod", "databricks-dev"}


def test_a_duplicate_explicit_name_is_rejected():
    register_provider(lambda: Provider(name="dup", transports=[]), name="dup")

    with pytest.raises(ValueError, match="'dup' is already registered"):
        register_provider(lambda: Provider(name="dup", transports=[]), name="dup")


def test_entry_point_group_is_named_once():
    # contrib/build.nix spells this group out.
    assert ENTRY_POINT_GROUP == "agent_broker.providers"


def test_a_broken_entry_point_does_not_stop_the_others(monkeypatch, caplog):
    class _Ep:
        def __init__(self, name, fail):
            self.name = name
            self._fail = fail

        def load(self):
            if self._fail:
                raise ImportError("no such module")

            @register_provider
            def from_entry_point() -> Provider:
                return Provider(name="from-ep", transports=[])

    # _load_entrypoint_providers imports entry_points inside the function, so swapping the module in sys.modules is enough.
    eps = [_Ep("broken", True), _Ep("good", False)]
    monkeypatch.setitem(
        sys.modules,
        "importlib.metadata",
        types.SimpleNamespace(entry_points=lambda group=None: eps),
    )

    with caplog.at_level("ERROR"):
        providers = discover_providers()

    assert {p.name for p in providers} == {"from-ep"}
    assert "failed loading provider entry-point" in caplog.text
