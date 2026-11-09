"""No broker store may build its own async engine, since scooter_broker_lib.store.open_sessions
is the one constructor carrying the pool sizing and pool_recycle, and a store
inherits them by having no other option.
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
        "pool sizing or pool_recycle: "
        f"{[str(p) for p in offenders]}"
    )
