"""The pure reconcile core — decides what the warm-store pool should DO given the
current PVCs, Sandboxes, and pods. No k8s, no I/O — fully unit-testable. The loop
(loop.py) is the imperative shell that lists, calls this, and applies the actions.

Pool model (see todo/docs/WARM_STORE_PVC_MANAGER.md):
- A pool PVC is a writable overlay UPPER (`upper/`+`work/`+`state/`) on an RWO PVC,
  KEYED by the sandbox image content tag it was warmed against (`warm-store` label).
  A PVC is ONLY claimable by a sandbox whose image tag matches — the no-fixup guarantee.
- pool-state ∈ {warming, ready, claimed, retiring}.
- The CONTROLLER owns top-up (warm Jobs) / GC / return-on-suspend / leak-recovery.
  The agent-host PROVISIONER does the claim (claimName swap) out-of-band; the controller
  only observes the resulting `claimed-by` label + the owning Sandbox.

This module decides, per current cluster state, the SET of actions to apply. It does NOT
claim (that's the provisioner) — it tops up, garbage-collects, and returns.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

# Terminal (or in-flight) state of a `warming` PVC's warm Job, resolved by the shell.
WarmJobStatus = Literal["succeeded", "failed", "running"]


# --- Observed state (the bits the decision depends on) ---------------------

@dataclass(frozen=True)
class PoolPvc:
    """A pool PVC as the controller sees it (from labels + bound state)."""

    name: str
    image_tag: str            # label scooter.io/warm-store — the version key (overlay lower identity)
    state: str                # label scooter.io/pool-state: warming|ready|claimed|retiring
    claimed_by: str | None = None   # label scooter.io/claimed-by (conv id) when claimed
    last_used: str | None = None    # label scooter.io/last-used (rfc3339) for LRU
    bound_to_pod: bool = False       # is a live pod currently mounting it? (RWO single-attach)
    # For a `warming` PVC: the terminal state of its warm Job, resolved by the shell.
    # "succeeded" → promote to ready; "failed" → discard; "running"/None → still warming.
    warm_job_status: WarmJobStatus | None = None


@dataclass(frozen=True)
class SandboxRef:
    """A per-conversation Sandbox the controller watches for return/leak signals."""

    conv_id: str              # the conversation id (== claimed-by on its pooled PVC)
    image_tag: str            # the sandbox's image content tag
    suspended: bool           # operatingMode != Running (agent-sandbox quiesced the pod)
    clean_unmount: bool = True  # did the overlay unmount cleanly on suspend? (dirty work/ ⇒ discard)


@dataclass(frozen=True)
class PoolConfig:
    """Pool knobs (from kubenix options)."""

    current_image_tag: str    # the sandbox image tag NEW conversations get — what to keep warm
    min_ready: int = 1        # top up until this many `ready` PVCs exist for current_image_tag
    max_total: int = 8        # cap total pool PVCs for the current tag (LRU-evict `ready` past this)


# --- Actions the shell will apply -----------------------------------------

@dataclass(frozen=True)
class WarmNew:
    """Create a fresh PVC (warming) + launch a warm Job against it for `image_tag`."""
    image_tag: str


@dataclass(frozen=True)
class Relabel:
    """Set the PVC's pool-state label (+ optional extra labels), e.g. claimed→ready on return."""
    pvc: str
    state: str
    labels: dict[str, str | None] = field(default_factory=dict)


@dataclass(frozen=True)
class DeletePvc:
    """Delete a PVC — GC of a retired image tag, an unclean return, or LRU eviction."""
    pvc: str
    reason: str


Action = WarmNew | Relabel | DeletePvc


CLAIMED_BY = "scooter.io/claimed-by"


def reconcile(
    pvcs: list[PoolPvc],
    sandboxes: list[SandboxRef],
    cfg: PoolConfig,
) -> list[Action]:
    """Decide the full set of pool actions for one pass. Pure: given the observed PVCs +
    Sandboxes + config, return the actions to apply (order-independent; the shell applies
    each). Covers: return-on-suspend, leak-recovery, GC by tag, top-up, LRU-evict.

    Precedence per PVC (at most ONE action per PVC): a claimed PVC is first considered for
    return/leak/discard; a ready PVC is considered for GC (retired tag) then LRU eviction.
    Only AFTER accounting for those do we top up the current tag toward min_ready.
    """
    actions: list[Action] = []
    sandbox_by_conv = {s.conv_id: s for s in sandboxes}

    # Track which current-tag `ready` PVCs survive this pass, for min_ready/LRU accounting.
    # A PVC that we return (claimed→ready) this pass counts toward readiness too.
    surviving_ready: list[PoolPvc] = []
    # Current-tag PVCs still WARMING (Job in-flight) — count toward min_ready so we don't
    # spawn a new warm every tick while one is already building (the over-warm bug).
    in_flight_warming = 0

    for p in pvcs:
        if p.state == "claimed":
            # A pod still holds the RWO PVC → in active use / mid-unmount. Never touch it
            # (relabeling `ready` could let a second pod double-mount → overlayfs corruption).
            if p.bound_to_pod:
                continue
            sbox = sandbox_by_conv.get(p.claimed_by) if p.claimed_by else None
            if sbox is not None and sbox.suspended:
                # Return-on-suspend: clean → relabel ready (self-enriching); unclean → discard.
                if sbox.clean_unmount:
                    actions.append(Relabel(pvc=p.name, state="ready", labels={CLAIMED_BY: None}))
                    if p.image_tag == cfg.current_image_tag:
                        surviving_ready.append(p)
                else:
                    actions.append(DeletePvc(pvc=p.name, reason="unclean-return"))
            elif sbox is None:
                # Leak recovery: the owning Sandbox is gone and no pod holds it → return.
                actions.append(Relabel(pvc=p.name, state="ready", labels={CLAIMED_BY: None}))
                if p.image_tag == cfg.current_image_tag:
                    surviving_ready.append(p)
            # else: sandbox present + running → active; leave it (no action).
            continue

        if p.state == "ready":
            # GC: a ready PVC for a RETIRED tag → delete (its lower is gone; DB dangles).
            if p.image_tag != cfg.current_image_tag:
                actions.append(DeletePvc(pvc=p.name, reason="retired-tag"))
                continue
            surviving_ready.append(p)
            continue

        if p.state == "warming":
            # Promote on the warm Job's terminal state: succeeded → ready (it now counts
            # toward min_ready, so we don't over-warm); failed → discard the half-baked PVC
            # (a fresh warm tops back up next pass). A retired-tag warming PVC is also junk.
            if p.image_tag != cfg.current_image_tag:
                actions.append(DeletePvc(pvc=p.name, reason="retired-tag"))
            elif p.warm_job_status == "succeeded":
                actions.append(Relabel(pvc=p.name, state="ready"))
                surviving_ready.append(p)
            elif p.warm_job_status == "failed":
                actions.append(DeletePvc(pvc=p.name, reason="warm-failed"))
            else:
                # "running"/None → still warming; count it so we don't over-warm this tick.
                in_flight_warming += 1
            continue

        # `retiring` PVCs: in-flight teardown; no action here.

    # LRU-evict current-tag `ready` PVCs past max_total (coldest last_used first).
    if len(surviving_ready) > cfg.max_total:
        # None-last_used sorts oldest (evict-first). Stable by name for determinism.
        by_age = sorted(surviving_ready, key=lambda p: (p.last_used or "", p.name))
        evict = by_age[: len(surviving_ready) - cfg.max_total]
        for p in evict:
            actions.append(DeletePvc(pvc=p.name, reason="lru-evict"))
        surviving_ready = by_age[len(surviving_ready) - cfg.max_total :]

    # Top up the CURRENT tag toward min_ready (after evictions, so we don't warm-then-evict).
    # Count in-flight warming PVCs toward the target so we don't spawn a new warm on EVERY
    # tick while one is already building (the over-warm bug: 0 ready + a warm in progress
    # would otherwise warm again and again until the first finishes).
    deficit = cfg.min_ready - len(surviving_ready) - in_flight_warming
    for _ in range(max(0, deficit)):
        actions.append(WarmNew(image_tag=cfg.current_image_tag))

    return actions
