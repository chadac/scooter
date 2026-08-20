"""Every async DB engine must survive a postgres restart / failover / idle-timeout.

Without `pool_pre_ping` the pool hands out a connection the server has already closed and the
request dies with asyncpg "connection is closed" on the next transaction — the service then stays
broken until it is itself restarted. `pool_recycle` retires connections proactively before common
idle-timeout windows rather than waiting to be bitten.

The webhooks engine added these after exactly that failure in production; the broker's three stores
and the scheduler's did not have them. This test asserts the whole fleet of engines is guarded, so a
new store cannot quietly ship without the protection.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

# Repo-relative paths of every module that constructs an async engine.
_SERVICES = Path(__file__).resolve().parents[2]
ENGINE_MODULES = [
    _SERVICES / "broker" / "broker" / "aws" / "store.py",
    _SERVICES / "broker" / "broker" / "sandbox" / "store.py",
    _SERVICES / "broker" / "broker" / "registry" / "store.py",
    _SERVICES / "scheduler" / "scheduler" / "store.py",
    _SERVICES / "webhooks" / "webhooks" / "store.py",
]


def _engine_calls(path: Path) -> list[ast.Call]:
    """Every create_async_engine(...) call in the module."""
    tree = ast.parse(path.read_text())
    out: list[ast.Call] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            fn = node.func
            name = getattr(fn, "id", None) or getattr(fn, "attr", None)
            if name == "create_async_engine":
                out.append(node)
    return out


@pytest.mark.parametrize("path", ENGINE_MODULES, ids=lambda p: str(p.relative_to(_SERVICES)))
def test_engine_has_reconnect_guards(path: Path) -> None:
    calls = _engine_calls(path)
    assert calls, f"{path} declares no create_async_engine call — update ENGINE_MODULES"
    for call in calls:
        kwargs = {kw.arg: kw.value for kw in call.keywords}
        assert "pool_pre_ping" in kwargs, (
            f"{path.name}:{call.lineno} create_async_engine without pool_pre_ping — a connection "
            f"closed by a postgres restart/failover will be handed out dead and fail the request"
        )
        pre_ping = kwargs["pool_pre_ping"]
        assert isinstance(pre_ping, ast.Constant) and pre_ping.value is True, (
            f"{path.name}:{call.lineno} pool_pre_ping must be True"
        )
        assert "pool_recycle" in kwargs, (
            f"{path.name}:{call.lineno} create_async_engine without pool_recycle — stale connections "
            f"are only retired reactively, after a request has already failed"
        )
        recycle = kwargs["pool_recycle"]
        assert isinstance(recycle, ast.Constant) and isinstance(recycle.value, int), (
            f"{path.name}:{call.lineno} pool_recycle must be an int (seconds)"
        )
        # Must be below common idle timeouts (pgbouncer/proxies commonly 3600s).
        assert 0 < recycle.value <= 3600, (
            f"{path.name}:{call.lineno} pool_recycle={recycle.value}s should be <= 3600s to stay "
            f"under typical idle-timeout windows"
        )
