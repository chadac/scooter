"""The reconcile LOOP — the imperative shell around reconcile.py. Lists pool PVCs +
Sandboxes, decides the action set, applies each (warm / relabel / delete). Leader-gated by
the caller (only the Lease holder runs reconcile_once).

Kept free of I/O DETAILS: it takes a ControllerK8s (real or fake), so the whole loop is
unit-testable against an in-memory fake (see test_loop.py)."""

from __future__ import annotations

import logging

from .allocate import LetVctProvision, ReleasePv, ReservePv, plan_allocation, plan_reclaim
from .reconcile import PoolConfig, WarmNew, Relabel, DeletePvc, reconcile

logger = logging.getLogger("loop")


def reconcile_once(k8s, cfg: PoolConfig, reservations=None) -> list[tuple[str, str]]:
    """One reconcile pass over the pool. Returns [(target, action_kind)] for logging/tests.
    Applies each action via the ControllerK8s; a per-action failure is logged and skipped so
    one bad PVC can't stall the whole pass.

    `reservations` (optional) is the in-flight PV set. Omitted, PV placement is skipped
    entirely and every sandbox falls through to its vct — the safe degrade, and what keeps
    older call sites (and tests) working unchanged."""
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

    if reservations is not None:
        results.extend(_place_volumes(k8s, reservations))
    return results


def _place_volumes(k8s, reservations) -> list[tuple[str, str]]:
    """Hand warm PVs to Sandboxes still waiting for their overlay upper, and recycle PVs
    whose PVC is gone.

    Failure is ALWAYS safe here: a sandbox we do not place simply gets a fresh empty upper
    from its vct. So a per-action error is logged and skipped, never raised — the pool is
    an optimization and must never be able to block a conversation from starting."""
    results: list[tuple[str, str]] = []
    try:
        # Nothing to place -> only reclaim needs the pool, and reclaim is cheap to skip
        # when there is nothing Released either. Check pending FIRST so an idle cluster
        # does not list PVs and nodes every interval for no reason.
        pending = k8s.list_pending_uppers()
        # Reclaim must see EVERY PV (any of them may be Released), so this one is
        # materialised. Placement below consumes it already sorted MRU-first, so the
        # first usable candidate is also the best one.
        pvs = list(k8s.iter_pool_pvs())
        nodes = k8s.list_nodes() if pending else []
    except Exception:  # noqa: BLE001 — a listing failure must not stall the pass
        logger.exception("PV placement: listing failed; sandboxes fall back to their vct")
        return results

    # DROP HOLDS FOR REALISED PVCs. Once the PVC exists the PV carries its own claimRef,
    # which excludes it from selection far more reliably than our cache — so the in-process
    # hold has done its job and must be released. Without this a hold lingers until its TTL
    # and needlessly withholds a volume that is already correctly bound.
    still_pending = {w.pvc_name for w in pending}
    for pv_ in pvs:
        if pv_.claim_ref and pv_.claim_ref not in still_pending:
            reservations.confirm(pv_.name)

    # Recycle first, so a PV released this pass can be allocated in the same pass.
    for a in plan_reclaim(pvs):
        try:
            k8s.release_pv(a.pv)
            reservations.release(a.pv)
            results.append((a.pv, "release-pv"))
            logger.info("returned a PV to the pool", extra={"pv": a.pv, "reason": a.reason})
        except Exception:  # noqa: BLE001
            logger.exception("release-pv failed", extra={"pv": a.pv})

    if not pending:
        return results

    for a in plan_allocation(pending, pvs, nodes, reservations.active()):
        if isinstance(a, LetVctProvision):
            # Not a failure — the designed cold-pool path. Logged so a pool that is never
            # placing anything is VISIBLE rather than quietly useless (the whole point of
            # the RBAC incident: a safe degrade with no signal hides a broken pool).
            logger.info("no warm PV placed; the vct will provision", extra={"sandbox": a.sandbox, "reason": a.reason})
            results.append((a.sandbox, "vct-provision"))
            continue
        if isinstance(a, ReservePv):
            # TAKE THE PV ATOMICALLY, and only write if we won. claim() is test-and-set
            # under one lock, so it is the single point that decides who owns this volume
            # — no two callers can both pass and then both patch claimRef. Holding before
            # the write also means a half-applied reserve (claimRef set, PVC create
            # failed) still withholds the PV; the TTL bounds it if we never confirm.
            if not reservations.claim(a.pv):
                logger.info(
                    "PV already claimed in-flight; the vct will provision",
                    extra={"pv": a.pv, "sandbox": a.sandbox},
                )
                results.append((a.sandbox, "vct-provision"))
                continue
            try:
                k8s.reserve_pv(a.pv, a.pvc_name, a.sandbox)
                results.append((a.pv, "reserve-pv"))
                logger.info(
                    "placed a warm PV",
                    extra={"pv": a.pv, "pvc": a.pvc_name, "sandbox": a.sandbox, "reason": a.reason},
                )
            except Exception:  # noqa: BLE001
                # ROLL BACK, or the fallback loop leaks a volume on every miss.
                logger.exception("reserve-pv failed; rolling back", extra={"pv": a.pv, "sandbox": a.sandbox})
                try:
                    k8s.release_pv(a.pv)
                except Exception:  # noqa: BLE001
                    logger.exception("reserve-pv rollback FAILED — the PV may stay reserved", extra={"pv": a.pv})
                reservations.release(a.pv)
    return results
