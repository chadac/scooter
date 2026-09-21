"""The handler registry MECHANISM, with the built-in scan as a parameter.

The webhooks app's own tests assert that its five built-in handlers are found
and mounted. These assert the machinery underneath, which is what moved here:
`discover_webhooks` used to do `from . import handlers`, hardcoding the app
package. It now takes the packages to scan, so a contrib-only caller passes
nothing and is still discovered through the entry-point group.

Mirrors scooter_broker_lib's test_registry — deliberately, since the two
registries are the same contract and drift between them is the bug worth
catching.
"""

from __future__ import annotations

import pathlib
import sys
import tempfile
import types

import pytest
from fastapi import APIRouter

from scooter_webhooks_lib import registry
from scooter_webhooks_lib.registry import (
    ENTRY_POINT_GROUP,
    WebhookHandler,
    discover_webhooks,
    register_webhook,
)


@pytest.fixture(autouse=True)
def _isolated_registry():
    """@register_webhook writes to module state; don't leak it across tests."""
    saved = dict(registry._REGISTRY)
    registry._REGISTRY.clear()
    yield
    registry._REGISTRY.clear()
    registry._REGISTRY.update(saved)


@pytest.fixture(autouse=True)
def _no_entry_points(monkeypatch, request):
    """Real installed entry points would make these tests depend on what else is
    in the environment. The entry-point path gets its own test below."""
    if "uses_entry_points" in request.keywords:
        return
    monkeypatch.setattr(registry, "_load_entrypoint_handlers", lambda: None)


_HANDLER_SOURCE = """
from fastapi import APIRouter
from scooter_webhooks_lib.registry import WebhookHandler, register_webhook

@register_webhook
def {factory}() -> WebhookHandler:
    router = APIRouter()

    @router.post("/webhooks/{name}")
    async def _hook() -> dict:
        return {{"handler": "{name}"}}

    return WebhookHandler(name="{name}", router=router, enabled={enabled})
"""


def _package(name: str, modules: dict[str, str]):
    """Build an importable throwaway package on disk.

    A real package, not a mock: the scan walks __path__ with pkgutil and imports
    by name, so a stub that does not do both proves nothing.
    """
    root = pathlib.Path(tempfile.mkdtemp())
    pkg_dir = root / name
    pkg_dir.mkdir()
    (pkg_dir / "__init__.py").write_text("")
    for mod_name, source in modules.items():
        (pkg_dir / f"{mod_name}.py").write_text(source)
    sys.path.insert(0, str(root))
    return __import__(name)


def test_scans_the_packages_it_is_given():
    pkg = _package(
        "scooter_test_handlers_a",
        {
            "alpha": _HANDLER_SOURCE.format(factory="alpha", name="alpha", enabled=True),
            "beta": _HANDLER_SOURCE.format(factory="beta", name="beta", enabled=True),
        },
    )
    assert {h.name for h in discover_webhooks([pkg])} == {"alpha", "beta"}


def test_scans_nothing_when_given_nothing():
    # A contrib-only service has no in-tree handlers; that must not be an error,
    # and it must not fall back to some hardcoded package.
    assert discover_webhooks() == []


def test_scans_more_than_one_package():
    a = _package(
        "scooter_test_handlers_b",
        {"one": _HANDLER_SOURCE.format(factory="one", name="one", enabled=True)},
    )
    b = _package(
        "scooter_test_handlers_c",
        {"two": _HANDLER_SOURCE.format(factory="two", name="two", enabled=True)},
    )
    assert {h.name for h in discover_webhooks([a, b])} == {"one", "two"}


def test_a_discovered_handler_carries_its_router():
    pkg = _package(
        "scooter_test_handlers_d",
        {"solo": _HANDLER_SOURCE.format(factory="solo", name="solo", enabled=True)},
    )
    (handler,) = discover_webhooks([pkg])
    assert isinstance(handler, WebhookHandler)
    assert isinstance(handler.router, APIRouter)
    assert "/webhooks/solo" in {r.path for r in handler.router.routes}


def test_a_disabled_handler_is_left_out():
    # Built-in handlers self-gate in-route; `enabled` is the mount-time knob a
    # third-party handler may prefer instead.
    pkg = _package(
        "scooter_test_handlers_e",
        {
            "on": _HANDLER_SOURCE.format(factory="on", name="on", enabled=True),
            "off": _HANDLER_SOURCE.format(factory="off", name="off", enabled=False),
        },
    )
    assert {h.name for h in discover_webhooks([pkg])} == {"on"}


def test_a_factory_that_raises_is_skipped_loudly(caplog):
    # One bad handler must not take down the whole service — but it is then
    # ABSENT (its routes 404), which reads exactly like "disabled" unless the log
    # says otherwise.
    @register_webhook
    def exploding() -> WebhookHandler:
        raise RuntimeError("bad config")

    @register_webhook
    def healthy() -> WebhookHandler:
        return WebhookHandler(name="healthy", router=APIRouter())

    with caplog.at_level("ERROR"):
        handlers = discover_webhooks()

    assert {h.name for h in handlers} == {"healthy"}
    assert "ABSENT" in caplog.text
    assert any(getattr(r, "handler", None) == "exploding" for r in caplog.records)


def test_register_webhook_keys_on_the_factory_name():
    @register_webhook
    def my_handler() -> WebhookHandler:
        return WebhookHandler(name="mounted-as-this", router=APIRouter())

    assert "my_handler" in registry._REGISTRY


def test_entry_point_group_is_named_once():
    # The contribs' pyproject files spell this group out; a drifted constant here
    # would silently stop discovering every contrib.
    assert ENTRY_POINT_GROUP == "scooter_webhooks.handlers"


@pytest.mark.uses_entry_points
def test_a_broken_entry_point_does_not_stop_the_others(monkeypatch, caplog):
    class _Ep:
        def __init__(self, name, fail):
            self.name = name
            self._fail = fail

        def load(self):
            if self._fail:
                raise ImportError("no such module")

            @register_webhook
            def from_entry_point() -> WebhookHandler:
                return WebhookHandler(name="from-ep", router=APIRouter())

    # _load_entrypoint_handlers imports entry_points INSIDE the function, so
    # swapping the module in sys.modules is enough — no import-order games.
    eps = [_Ep("broken", True), _Ep("good", False)]
    monkeypatch.setitem(
        sys.modules,
        "importlib.metadata",
        types.SimpleNamespace(entry_points=lambda group=None: eps),
    )

    with caplog.at_level("ERROR"):
        handlers = discover_webhooks()

    assert {h.name for h in handlers} == {"from-ep"}
    assert "failed loading webhook handler entry-point" in caplog.text
