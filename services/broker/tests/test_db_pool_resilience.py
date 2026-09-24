"""No broker store may build its own async engine — they all go through the surface.

Without `pool_pre_ping` the pool hands out a connection the server has already closed
and the request dies with asyncpg "connection is closed"; the service then stays
broken until it is itself restarted. `pool_recycle` retires connections proactively
before common idle-timeout windows rather than waiting to be bitten. The webhooks
engine added both after exactly that failure in production.

This used to enumerate the modules that build an engine and check each one's kwargs —
and it had already missed shares/store.py, which was added later and guarded only
because its author happened to copy registry/store.py. Since PR #622 there is ONE
engine constructor (scooter_broker_lib.store.open_sessions, which carries the guards
and is tested there), so the useful assertion here is the inverse: nothing in the
broker constructs an engine itself, because that is the only way back to an unguarded
one. A new store — or a contrib's — inherits the guards by having no other option.
"""

from __future__ import annotations

import ast
from pathlib import Path

_BROKER = Path(__file__).resolve().parents[1] / "broker"


def modules_calling_create_async_engine() -> list[Path]:
    """Every broker module with a create_async_engine(...) call of its own."""
    offenders = []
    for path in sorted(_BROKER.rglob("*.py")):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and (
                getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            ) == "create_async_engine":
                offenders.append(path)
                break
    return offenders


def test_no_store_builds_its_own_engine() -> None:
    offenders = modules_calling_create_async_engine()
    assert not offenders, (
        "these modules call create_async_engine directly instead of "
        "scooter_broker_lib.store.open_sessions, so their pool has no "
        "pool_pre_ping/pool_recycle and a postgres restart or failover will break "
        f"the service until it is itself restarted: {[str(p) for p in offenders]}"
    )
