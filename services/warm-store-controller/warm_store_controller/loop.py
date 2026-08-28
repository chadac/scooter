"""The reconcile LOOP — the imperative shell around reconcile.py. Lists pool PVCs +
Sandboxes, decides the action set, applies each (warm / relabel / delete). Leader-gated by
the caller (only the Lease holder runs reconcile_once).

Kept free of I/O DETAILS: it takes a ControllerK8s (real or fake), so the whole loop is
unit-testable against an in-memory fake (see test_loop.py)."""

from __future__ import annotations

import logging

from kubernetes.client.exceptions import ApiException

from .allocate import Node, PendingSandbox, PoolPv, candidates_for
from .reservations import AlreadyClaimed, Reservations
from .k8s import ControllerK8s
from .reconcile import PoolConfig, WarmNew, Relabel, DeletePvc, reconcile

logger = logging.getLogger("loop")


def reconcile_once(
    k8s: ControllerK8s,
    cfg: PoolConfig,
    reservations: Reservations,
    affinity: dict[str, str],
) -> None:
    """One reconcile pass. A per-action failure is logged and skipped, so one bad volume
    cannot stall the rest."""
    for a in reconcile(k8s.list_pool_pvcs(), k8s.list_sandboxes(), cfg):
        try:
            if isinstance(a, WarmNew):
                k8s.warm_new(a.image_tag)
                logger.info("warming a new pool PVC", extra={"image_tag": a.image_tag})
            elif isinstance(a, Relabel):
                k8s.relabel(a.pvc, a.state, a.labels)
                logger.info("relabel pool PVC", extra={"pvc": a.pvc, "state": a.state, "labels": a.labels})
            elif isinstance(a, DeletePvc):
                k8s.delete_pvc(a.pvc)
                logger.info("delete pool PVC", extra={"pvc": a.pvc, "reason": a.reason})
        except Exception:  # noqa: BLE001 — one failed action must not abort the pass
            logger.exception(
                "action failed",
                extra={"action": type(a).__name__, "target": getattr(a, "pvc", None) or getattr(a, "image_tag", None)},
            )

    # --- PV placement. Every failure below degrades to "the vct provisions a fresh
    # upper", so errors are logged and skipped: the pool must never block a conversation.
    try:
        # pending FIRST so an idle cluster does not list PVs and nodes every interval.
        pending = k8s.list_pending_uppers()
        pvs = list(k8s.iter_pool_pvs())
        nodes = k8s.list_nodes() if pending else []
    except ApiException:
        logger.exception("PV placement: listing failed; sandboxes fall back to their vct")
        return

    # BOUND = genuinely in use: record affinity here, not at reservation. PR #403.
    still_pending = {w.pvc_name for w in pending}
    for pv in pvs:
        if pv.claim_ref and pv.claim_ref not in still_pending:
            reservations.release(pv.name)
            affinity[_sandbox_of_pvc(pv.claim_ref)] = pv.name

    # Recycle BEFORE allocating, so a PV freed this pass is usable in it. Skip terminating
    # ones: touching them restarts the delete->terminating->re-read spin (#399).
    for pv in pvs:
        if pv.phase != "Released" or pv.terminating:
            continue
        try:
            k8s.release_pv(pv.name)
            reservations.release(pv.name)
            logger.info("returned a PV to the pool", extra={"pv": pv.name})
        except ApiException:
            logger.exception("release-pv failed", extra={"pv": pv.name})

    # Pool size for the growth cap below. Counted ONCE per pass: _place_one grows it as it
    # goes, and re-listing per sandbox would let a burst blow past max_total.
    pool_size = sum(1 for pv in pvs if not pv.terminating)
    for want in pending:
        if _place_one(k8s, reservations, want, pvs, nodes, affinity, cfg.max_total - pool_size):
            pool_size += 1


def _sandbox_of_pvc(pvc_name: str) -> str:
    """The sandbox a `scooter-rw-<sandbox>` PVC belongs to. The name is the contract
    between us and the vct (it generates exactly this), so it is the binding's only
    record of who owns the volume."""
    return pvc_name[len("scooter-rw-"):] if pvc_name.startswith("scooter-rw-") else pvc_name


def _place_one(
    k8s: ControllerK8s,
    reservations: Reservations,
    want: PendingSandbox,
    pvs: list[PoolPv],
    nodes: list[Node],
    affinity: dict[str, str],
    headroom: int,
) -> bool:
    """Give ONE sandbox a warm PV, or grow the pool, or fall back to its vct. Selfish: take
    the first candidate we win, so a lost race costs the next-best volume, not the
    placement. Returns True if it grew the pool."""
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
                if affinity.get(want.sandbox) == pv.name
                else "assigning a warm pool PV",
            },
        )
        return False

    # No warm volume for us. Under the cap, take a POOL-class PVC instead of letting the
    # vct make one on the default class: a default-class volume is Delete-reclaimed and
    # unlabelled, so it dies with the sandbox and the pool never grows from real use.
    if headroom > 0:
        try:
            k8s.grow_pool(want.pvc_name, want.image_tag)
            logger.info("grew the warm pool", extra={"sandbox": want.sandbox, "pvc": want.pvc_name})
            return True
        except ApiException:
            logger.exception("grow-pool failed; the vct will provision", extra={"sandbox": want.sandbox})
            return False

    # At the cap: let the vct provision an ordinary volume on the default class.
    logger.info("pool at capacity; the vct will provision", extra={"sandbox": want.sandbox})
    return False

