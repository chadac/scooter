"""The reconcile LOOP — the imperative shell around reconcile.py. Lists pool PVCs +
Sandboxes, decides the action set, applies each (warm / relabel / delete). Leader-gated by
the caller (only the Lease holder runs reconcile_once).

Kept free of I/O DETAILS: it takes a ControllerK8s (real or fake), so the whole loop is
unit-testable against an in-memory fake (see test_loop.py)."""

from __future__ import annotations

import logging

from kubernetes.client.exceptions import ApiException

from .allocate import candidates_for, plan_reclaim
from .reservations import AlreadyClaimed
from .reconcile import PoolConfig, WarmNew, Relabel, DeletePvc, reconcile

logger = logging.getLogger("loop")


def reconcile_once(
    k8s,
    cfg: PoolConfig,
    reservations=None,
    affinity: dict[str, str] | None = None,
) -> list[tuple[str, str]]:
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
        results.extend(_place_volumes(k8s, reservations, affinity))
    return results


def _place_volumes(k8s, reservations, affinity: dict[str, str] | None = None) -> list[tuple[str, str]]:
    """Hand warm PVs to Sandboxes awaiting an upper; recycle PVs whose PVC is gone.

    Every failure is safe: an unplaced sandbox gets a fresh upper from its vct. So errors
    are logged and skipped, never raised — the pool must never block a conversation."""
    results: list[tuple[str, str]] = []
    try:
        # pending FIRST so an idle cluster does not list PVs and nodes every interval.
        pending = k8s.list_pending_uppers()
        # Materialised: reclaim must see EVERY PV. Already MRU-sorted for placement.
        pvs = list(k8s.iter_pool_pvs())
        nodes = k8s.list_nodes() if pending else []
    except ApiException:
        logger.exception("PV placement: listing failed; sandboxes fall back to their vct")
        return results

    # A BOUND PV is one a sandbox is genuinely using, so this is where affinity is
    # recorded — not at reservation time, where a claim that never binds would falsely
    # mark the volume as that sandbox's warm store. It is also where the local hold is
    # done: the PV's own claimRef excludes it now, and keeping the hold would withhold an
    # already-bound volume until the TTL.
    still_pending = {w.pvc_name for w in pending}
    for pv_ in pvs:
        if pv_.claim_ref and pv_.claim_ref not in still_pending:
            reservations.release(pv_.name)
            if affinity is not None:
                affinity[_sandbox_of_pvc(pv_.claim_ref)] = pv_.name

    # Recycle first, so a PV released this pass can be allocated in the same pass.
    for a in plan_reclaim(pvs):
        try:
            k8s.release_pv(a.pv)
            reservations.release(a.pv)
            results.append((a.pv, "release-pv"))
            logger.info("returned a PV to the pool", extra={"pv": a.pv, "reason": a.reason})
        except ApiException:
            logger.exception("release-pv failed", extra={"pv": a.pv})

    if not pending:
        return results

    for want in pending:
        placed = _place_one(k8s, reservations, want, pvs, nodes, affinity)
        results.append(placed)
    return results


def _sandbox_of_pvc(pvc_name: str) -> str:
    """The sandbox a `scooter-rw-<sandbox>` PVC belongs to. The name is the contract
    between us and the vct (it generates exactly this), so it is the binding's only
    record of who owns the volume."""
    return pvc_name[len("scooter-rw-"):] if pvc_name.startswith("scooter-rw-") else pvc_name


def _place_one(k8s, reservations, want, pvs, nodes, affinity) -> tuple[str, str]:
    """Give ONE sandbox a warm PV, or fall back to its vct.

    Selfish: walk our own ranked candidates and take the first we win. claim() is the only
    arbiter — losing a race just means trying the next candidate, not giving up, so a
    contended pool still places everyone it can. Nothing here coordinates with other
    sandboxes, which is what makes this safe to run concurrently later.
    """
    for pv in candidates_for(want, pvs, nodes, affinity):
        try:
            reservations.claim(pv.name, want.sandbox)
        except AlreadyClaimed:
            continue  # someone holds it; try the next-best
        try:
            k8s.reserve_pv(pv.name, want.pvc_name, want.sandbox)
        except ApiException:
            # ROLL BACK, or the pool leaks a volume on every miss.
            logger.exception("reserve-pv failed; rolling back", extra={"pv": pv.name, "sandbox": want.sandbox})
            try:
                k8s.release_pv(pv.name)
            except ApiException:
                logger.exception("reserve-pv rollback FAILED — the PV may stay reserved", extra={"pv": pv.name})
            reservations.release(pv.name)
            continue  # a broken PV must not cost us the whole placement
        logger.info(
            "placed a warm PV",
            extra={
                "pv": pv.name,
                "pvc": want.pvc_name,
                "sandbox": want.sandbox,
                "reason": "reusing a volume this sandbox has warmed"
                if (affinity or {}).get(want.sandbox) == pv.name
                else "assigning a warm pool PV",
            },
        )
        return (pv.name, "reserve-pv")

    # Not a failure — the cold-pool path. Logged so a pool that never places anything is
    # visible; a safe degrade with no signal hides a broken pool.
    logger.info("no warm PV placed; the vct will provision", extra={"sandbox": want.sandbox})
    return (want.sandbox, "vct-provision")

