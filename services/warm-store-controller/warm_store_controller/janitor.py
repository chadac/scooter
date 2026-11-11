"""Pool upkeep: the pure decisions of one controller pass, with no k8s and no I/O.

Each pass labels bound pool PVs, recycles clean released ones, retires what cannot be
reused, clears stale reservations, finishes suspend releases and promotes warm PVCs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from .allocate import POOL_RETURNED, POOL_WARM, PoolPv

OVERLAY_PREFIX = "scooter-rw-"
WARM_PVC_PREFIX = "warm-store-"
LBL_RELEASE = "scooter.io/release"            # "requested" on a suspended sandbox's overlay PVC
LBL_WARM_SEED = "scooter.io/warm-seed"        # on a warm PVC
LBL_MARKER_PVC = "scooter.io/marker-pvc"      # on a marker-check Job: the PVC it reads

MarkerStatus = Literal["running", "clean", "dirty", "unknown"]
JobStatus = Literal["running", "succeeded", "failed"]


# --- observed state ------------------------------------------------------------

@dataclass(frozen=True)
class Pvc:
    name: str
    phase: str = "Pending"
    volume_name: str | None = None
    storage_class: str | None = None
    labels: dict[str, str] = field(default_factory=dict)
    terminating: bool = False
    created_at: float = 0.0


@dataclass(frozen=True)
class Sandbox:
    name: str
    tag: str
    suspended: bool
    created_at: float = 0.0


@dataclass(frozen=True)
class WarmJob:
    status: JobStatus
    node: str | None = None


@dataclass(frozen=True)
class World:
    """One pass's view of the cluster."""

    pvs: list[PoolPv]
    pvcs: dict[str, Pvc]
    sandboxes: dict[str, Sandbox]
    mounted: set[str]                      # PVC names a live pod mounts
    warm_jobs: dict[str, WarmJob]          # by the PVC they warm
    markers: dict[str, MarkerStatus]       # by the PVC they read


@dataclass(frozen=True)
class UpkeepConfig:
    current_tag: str
    pool_class: str
    reserve_grace: float = 600.0
    marker_retries: int = 3
    warm_orphan_after: float = 120.0


# --- actions -----------------------------------------------------------------------

@dataclass(frozen=True)
class LabelPv:
    """Record a bound PV's tag and user; it is out of every pool while bound."""
    pv: PoolPv
    tag: str
    last_sandbox: str | None
    drop_shutdown: bool


@dataclass(frozen=True)
class Recycle:
    """Clear a released PV's claimRef and put it in `pool`."""
    pv: PoolPv
    pool: str


@dataclass(frozen=True)
class RetirePv:
    """Have the provisioner wipe the PV."""
    pv: PoolPv
    reason: str


@dataclass(frozen=True)
class ClearReservation:
    """Drop a pre-bind nobody picked up."""
    pv: PoolPv


@dataclass(frozen=True)
class Unrelease:
    """The sandbox resumed: keep its PVC."""
    pvc: str


@dataclass(frozen=True)
class DeletePvc:
    pvc: str
    reason: str


@dataclass(frozen=True)
class DropRelease:
    """A suspended sandbox's PVC with no pool PV behind it: delete it."""
    pvc: str
    reason: str


@dataclass(frozen=True)
class StartMarkerCheck:
    pvc: str


@dataclass(frozen=True)
class MarkerUnknown:
    """The check could not read the volume; drop the Job and count an attempt."""
    pvc: str


@dataclass(frozen=True)
class FinishRelease:
    """Hand a suspended sandbox's PV back: clean to recycle, otherwise to retire."""
    pvc: str
    pv: str
    clean: bool
    reason: str


@dataclass(frozen=True)
class PromoteWarm:
    """A warm Job succeeded: mark the PV clean and let its PVC go."""
    pvc: str
    pv: str


Action = (
    LabelPv | Recycle | RetirePv | ClearReservation | Unrelease | DeletePvc | DropRelease
    | StartMarkerCheck | MarkerUnknown | FinishRelease | PromoteWarm
)


def sandbox_of(pvc: str) -> str | None:
    """The sandbox an overlay PVC belongs to, or None for any other PVC."""
    return pvc[len(OVERLAY_PREFIX):] if pvc.startswith(OVERLAY_PREFIX) else None


def epoch(stamp: str | None) -> float:
    """An rfc3339 stamp in epoch seconds; a missing or bad one reads as 0."""
    if not stamp:
        return 0.0
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def plan_upkeep(
    world: World,
    cfg: UpkeepConfig,
    now: float,
    marker_attempts: dict[str, int],
) -> tuple[list[Action], list[str | None]]:
    """Decide this pass's upkeep, and the node of each warm PV not yet in the pool."""
    actions: list[Action] = []
    pv_by_name = {pv.name: pv for pv in world.pvs}
    warming: list[str | None] = []
    for pv in world.pvs:
        a = _pv_action(pv, world, cfg, now)
        if a is not None:
            actions.append(a)
            # Recycled this pass; idle only from the next.
            if isinstance(a, Recycle) and a.pool == POOL_WARM:
                warming.append(pv.node)

    for pvc in world.pvcs.values():
        if pvc.terminating:
            # A promoted warm PVC, held until its Job's pod goes.
            if _is_current_warm(pvc, cfg):
                warming.append(_node_of(pvc, pv_by_name))
            continue
        if pvc.labels.get(LBL_RELEASE) == "requested":
            a = _release_action(pvc, world, cfg, pv_by_name, marker_attempts)
            if a is not None:
                actions.append(a)
        elif pvc.labels.get(LBL_WARM_SEED):
            a = _warm_action(pvc, world, cfg, now, warming)
            if a is not None:
                actions.append(a)
    return actions, warming


def _pv_action(pv: PoolPv, world: World, cfg: UpkeepConfig, now: float) -> Action | None:
    # A Delete policy means the PV is already going.
    if pv.terminating or pv.reclaim_policy == "Delete":
        return None

    if pv.phase == "Bound" and pv.claim_ref:
        sandbox = sandbox_of(pv.claim_ref)
        pvc = world.pvcs.get(pv.claim_ref)
        if sandbox is not None:
            sb = world.sandboxes.get(sandbox)
            tag = sb.tag if sb else pv.image_tag
        elif pvc is not None and pvc.labels.get(LBL_WARM_SEED):
            tag = pvc.labels.get("scooter.io/warm-store", "")
        else:
            return None
        # A rewritten volume must not keep a stale clean mark.
        drop = pv.shutdown_clean and pv.claim_ref in world.mounted
        if tag != pv.image_tag or (sandbox and pv.last_sandbox != sandbox) or pv.pool is not None or drop:
            return LabelPv(pv, tag, sandbox, drop)
        return None

    if pv.phase == "Released":
        if not pv.shutdown_clean:
            return RetirePv(pv, "released-unchecked")
        # Upper paths can reference paths only the old image's lower has.
        if not pv.image_tag or pv.image_tag != cfg.current_tag:
            return RetirePv(pv, "retired-tag")
        warm = (pv.claim_ref or "").startswith(WARM_PVC_PREFIX)
        return Recycle(pv, POOL_WARM if warm else POOL_RETURNED)

    if pv.phase == "Available":
        if pv.claim_ref is not None:
            return ClearReservation(pv) if _stale_reservation(pv, world, cfg, now) else None
        if pv.pool is None:
            return RetirePv(pv, "unpooled")
        if pv.image_tag != cfg.current_tag:
            return RetirePv(pv, "retired-tag")
    return None


def _stale_reservation(pv: PoolPv, world: World, cfg: UpkeepConfig, now: float) -> bool:
    if now - epoch(pv.reserved_at) < cfg.reserve_grace:
        return False
    pvc = world.pvcs.get(pv.claim_ref or "")
    if pvc is None or (pvc.volume_name and pvc.volume_name != pv.name):
        return True
    sandbox = sandbox_of(pvc.name)
    sb = world.sandboxes.get(sandbox) if sandbox else None
    return sb is None or sb.suspended


def _release_action(
    pvc: Pvc,
    world: World,
    cfg: UpkeepConfig,
    pv_by_name: dict[str, PoolPv],
    attempts: dict[str, int],
) -> Action | None:
    sandbox = sandbox_of(pvc.name)
    sb = world.sandboxes.get(sandbox) if sandbox else None
    if sb is not None and not sb.suspended:
        return Unrelease(pvc.name)
    # Wait so the marker read sees the final upper.
    if pvc.name in world.mounted:
        return None
    if not pvc.volume_name:
        return DropRelease(pvc.name, "release-unbound")
    pv = pv_by_name.get(pvc.volume_name)
    if pv is None or pvc.storage_class != cfg.pool_class:
        return DropRelease(pvc.name, "release-legacy")

    status = world.markers.get(pvc.name)
    if status == "running":
        return None
    if status == "clean":
        return FinishRelease(pvc.name, pv.name, True, "clean")
    if status == "dirty":
        return FinishRelease(pvc.name, pv.name, False, "unclean-shutdown")
    if status == "unknown":
        return MarkerUnknown(pvc.name)
    if attempts.get(pvc.name, 0) >= cfg.marker_retries:
        return FinishRelease(pvc.name, pv.name, False, "marker-unreadable")
    return StartMarkerCheck(pvc.name)


def _is_current_warm(pvc: Pvc, cfg: UpkeepConfig) -> bool:
    return bool(pvc.labels.get(LBL_WARM_SEED)) and pvc.labels.get("scooter.io/warm-store") == cfg.current_tag


def _node_of(pvc: Pvc, pv_by_name: dict[str, PoolPv]) -> str | None:
    pv = pv_by_name.get(pvc.volume_name or "")
    return pv.node if pv is not None else None


def _warm_action(
    pvc: Pvc,
    world: World,
    cfg: UpkeepConfig,
    now: float,
    warming: list[str | None],
) -> Action | None:
    if pvc.labels.get("scooter.io/warm-store") != cfg.current_tag:
        return DeletePvc(pvc.name, "retired-tag")
    job = world.warm_jobs.get(pvc.name)
    if job is None:
        if now - pvc.created_at > cfg.warm_orphan_after:
            return DeletePvc(pvc.name, "warm-orphan")
        warming.append(None)
        return None
    if job.status == "succeeded":
        if not pvc.volume_name:
            return DeletePvc(pvc.name, "warm-unbound")
        # Joins the pool in a pass or two; count it meanwhile.
        warming.append(job.node)
        return PromoteWarm(pvc.name, pvc.volume_name)
    if job.status == "failed":
        return DeletePvc(pvc.name, "warm-failed")
    warming.append(job.node)
    return None
