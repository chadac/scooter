"""The broker's async DB engines must survive a postgres restart / failover / idle-timeout.

Without `pool_pre_ping` the pool hands out a connection the server has already closed and the
request dies with asyncpg "connection is closed" on the next transaction — the service then stays
broken until it is itself restarted. `pool_recycle` retires connections proactively before common
idle-timeout windows rather than waiting to be bitten.

The webhooks engine added these after exactly that failure in production; the broker's three stores
did not have them. This guards the broker's own engines so a new store cannot ship without the
protection. (The scheduler and webhooks each carry the same check for THEIR modules — each service's
nix build sandbox contains only its own source, so a cross-service check would fail to find the
files.)
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_BROKER = Path(__file__).resolve().parents[1] / "broker"
ENGINE_MODULES = [
    _BROKER / "aws" / "store.py",
    _BROKER / "sandbox" / "store.py",
]


def engine_calls(path: Path) -> list[ast.Call]:
    """Every create_async_engine(...) call in the module."""
    tree = ast.parse(path.read_text())
    return [
        n
        for n in ast.walk(tree)
        if isinstance(n, ast.Call)
        and (getattr(n.func, "id", None) or getattr(n.func, "attr", None)) == "create_async_engine"
    ]


def assert_guarded(path: Path) -> None:
    """Assert every engine in `path` has reconnect guards. Shared by the sibling services' copies."""
    calls = engine_calls(path)
    assert calls, f"{path} declares no create_async_engine call — update ENGINE_MODULES"
    for call in calls:
        kwargs = {kw.arg: kw.value for kw in call.keywords}
        pre_ping = kwargs.get("pool_pre_ping")
        assert isinstance(pre_ping, ast.Constant) and pre_ping.value is True, (
            f"{path.name}:{call.lineno} create_async_engine without pool_pre_ping=True — a connection "
            f"closed by a postgres restart/failover will be handed out dead and fail the request"
        )
        recycle = kwargs.get("pool_recycle")
        assert isinstance(recycle, ast.Constant) and isinstance(recycle.value, int), (
            f"{path.name}:{call.lineno} create_async_engine without an int pool_recycle — stale "
            f"connections are only retired reactively, after a request has already failed"
        )
        assert 0 < recycle.value <= 3600, (
            f"{path.name}:{call.lineno} pool_recycle={recycle.value}s should be <= 3600s to stay "
            f"under typical idle-timeout windows"
        )


@pytest.mark.parametrize("path", ENGINE_MODULES, ids=lambda p: p.parent.name)
def test_engine_has_reconnect_guards(path: Path) -> None:
    assert_guarded(path)
