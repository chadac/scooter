"""The reconcile LOOP — the imperative shell around reconcile.py. Lists pool PVCs +
Sandboxes, decides the action set, applies each (warm / relabel / delete). Leader-gated by
the caller (only the Lease holder runs reconcile_once).

Kept free of I/O DETAILS: it takes a ControllerK8s (real or fake), so the whole loop is
unit-testable against an in-memory fake (see test_loop.py)."""

from __future__ import annotations

import logging

from .reconcile import PoolConfig, WarmNew, Relabel, DeletePvc, reconcile

logger = logging.getLogger("loop")


def reconcile_once(k8s, cfg: PoolConfig) -> list[tuple[str, str]]:
    """One reconcile pass over the pool. Returns [(target, action_kind)] for logging/tests.
    Applies each action via the ControllerK8s; a per-action failure is logged and skipped so
    one bad PVC can't stall the whole pass."""
    pvcs = k8s.list_pool_pvcs()
    sandboxes = k8s.list_sandboxes()
    actions = reconcile(pvcs, sandboxes, cfg)

    results: list[tuple[str, str]] = []
    for a in actions:
        try:
            if isinstance(a, WarmNew):
                k8s.warm_new(a.image_tag)
                results.append((a.image_tag, "warm"))
                logger.info("warming a new pool PVC", extra={"image_tag": a.image_tag})
            elif isinstance(a, Relabel):
                k8s.relabel(a.pvc, a.state, a.labels)
                results.append((a.pvc, "relabel"))
                logger.info(
                    "relabel pool PVC",
                    extra={"pvc": a.pvc, "state": a.state, "labels": a.labels},
                )
            elif isinstance(a, DeletePvc):
                k8s.delete_pvc(a.pvc)
                results.append((a.pvc, "delete"))
                logger.info("delete pool PVC", extra={"pvc": a.pvc, "reason": a.reason})
        except Exception:  # noqa: BLE001 — one failed action must not abort the pass
            logger.exception(
                "action failed",
                extra={"action": type(a).__name__, "target": getattr(a, "pvc", None) or getattr(a, "image_tag", None)},
            )
    return results
