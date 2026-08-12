"""Tier 1 — the pure warm-store reconcile core (no k8s). Locks the pool decisions:
return-on-suspend, leak-recovery, GC-by-tag, top-up, LRU-evict. These tests ARE the spec
(red-first); reconcile.py is implemented to turn them green.
"""

from warm_store_controller.reconcile import (
    PoolPvc,
    SandboxRef,
    PoolConfig,
    WarmNew,
    Relabel,
    DeletePvc,
    reconcile,
)

TAG = "abc123def456"       # the current sandbox image content tag
OLD = "000oldtag0000"      # a retired image tag


def cfg(min_ready=1, max_total=8, tag=TAG) -> PoolConfig:
    return PoolConfig(current_image_tag=tag, min_ready=min_ready, max_total=max_total)


def kinds(actions) -> set[str]:
    return {type(a).__name__ for a in actions}


# --- top-up ----------------------------------------------------------------

def test_topup_when_no_ready_pvc_for_current_tag():
    # Empty pool, min_ready=1 -> warm one new PVC for the current tag.
    actions = reconcile(pvcs=[], sandboxes=[], cfg=cfg(min_ready=1))
    warms = [a for a in actions if isinstance(a, WarmNew)]
    assert len(warms) == 1
    assert warms[0].image_tag == TAG


def test_topup_ready_and_in_flight_warming_both_count():
    # A ready PVC satisfies min_ready...
    pvcs = [PoolPvc(name="r1", image_tag=TAG, state="ready")]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=1))
    assert not any(isinstance(a, WarmNew) for a in actions)

    # ...and so does an IN-FLIGHT warming PVC (its Job is building) — we must NOT warm another
    # every tick while one is in progress (the over-warm bug). A warming PVC with no resolved
    # job status is treated as in-flight.
    pvcs = [PoolPvc(name="w1", image_tag=TAG, state="warming", warm_job_status="running")]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=1))
    assert not any(isinstance(a, WarmNew) for a in actions)


def test_topup_ignores_ready_of_other_tag():
    # A ready PVC for a DIFFERENT tag doesn't satisfy the current tag's min_ready.
    pvcs = [PoolPvc(name="r-old", image_tag=OLD, state="ready")]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=1))
    assert any(isinstance(a, WarmNew) and a.image_tag == TAG for a in actions)


def test_topup_multiple_to_reach_min_ready():
    actions = reconcile(pvcs=[], sandboxes=[], cfg=cfg(min_ready=3))
    assert sum(isinstance(a, WarmNew) for a in actions) == 3


# --- warming → ready promotion (the pool-warms-forever bug guard) -----------

def test_promote_warming_pvc_on_job_success():
    pvcs = [PoolPvc(name="w1", image_tag=TAG, state="warming", warm_job_status="succeeded")]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=1))
    rels = [a for a in actions if isinstance(a, Relabel) and a.pvc == "w1"]
    assert rels and rels[0].state == "ready"
    # Promoted PVC satisfies min_ready → NO new warm.
    assert not any(isinstance(a, WarmNew) for a in actions)


def test_discard_warming_pvc_on_job_failure():
    pvcs = [PoolPvc(name="w1", image_tag=TAG, state="warming", warm_job_status="failed")]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=0))
    assert any(isinstance(a, DeletePvc) and a.pvc == "w1" for a in actions)


def test_in_flight_warming_does_not_over_warm():
    # A warm still RUNNING counts toward min_ready → we do NOT spawn another every tick
    # (the live-observed over-warm bug: 0 ready + 1 warming would warm again and again).
    pvcs = [PoolPvc(name="w1", image_tag=TAG, state="warming", warm_job_status="running")]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=1))
    assert not any(isinstance(a, WarmNew) for a in actions)
    # ...but with min_ready=2 and only 1 in-flight, we top up exactly ONE more.
    actions2 = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=2))
    assert sum(isinstance(a, WarmNew) for a in actions2) == 1


def test_warming_retired_tag_is_discarded():
    pvcs = [PoolPvc(name="w-old", image_tag=OLD, state="warming", warm_job_status="running")]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=0))
    assert any(isinstance(a, DeletePvc) and a.pvc == "w-old" for a in actions)


# --- GC by tag -------------------------------------------------------------

def test_gc_deletes_retired_tag_pvc():
    # A ready PVC for a retired tag -> delete (its lower is gone; DB would dangle).
    pvcs = [PoolPvc(name="r-old", image_tag=OLD, state="ready")]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=0))
    assert DeletePvc("r-old", reason="retired-tag") in [
        DeletePvc(a.pvc, a.reason) for a in actions if isinstance(a, DeletePvc)
    ] or any(isinstance(a, DeletePvc) and a.pvc == "r-old" for a in actions)


def test_gc_does_not_delete_claimed_retired_tag_still_in_use():
    # A retired-tag PVC that's still CLAIMED + bound to a live pod must NOT be yanked
    # out from under a running conversation — GC waits until it's returned/unbound.
    pvcs = [PoolPvc(name="c-old", image_tag=OLD, state="claimed", claimed_by="conv-x", bound_to_pod=True)]
    sboxes = [SandboxRef(conv_id="conv-x", image_tag=OLD, suspended=False)]
    actions = reconcile(pvcs=pvcs, sandboxes=sboxes, cfg=cfg(min_ready=0))
    assert not any(isinstance(a, DeletePvc) and a.pvc == "c-old" for a in actions)


# --- return-on-suspend -----------------------------------------------------

def test_return_claimed_pvc_when_sandbox_suspended_clean():
    # Sandbox suspended + clean unmount -> relabel its claimed PVC back to `ready`
    # (self-enriching: it carries this agent's installs), clearing claimed-by.
    pvcs = [PoolPvc(name="p1", image_tag=TAG, state="claimed", claimed_by="conv-a", bound_to_pod=False)]
    sboxes = [SandboxRef(conv_id="conv-a", image_tag=TAG, suspended=True, clean_unmount=True)]
    actions = reconcile(pvcs=pvcs, sandboxes=sboxes, cfg=cfg(min_ready=1))
    rels = [a for a in actions if isinstance(a, Relabel) and a.pvc == "p1"]
    assert len(rels) == 1
    assert rels[0].state == "ready"
    assert rels[0].labels.get("scooter.io/claimed-by") is None  # cleared


def test_return_discards_pvc_on_unclean_unmount():
    # A crash / dirty overlay work/ -> DISCARD the PVC (delete), don't return it dirty.
    pvcs = [PoolPvc(name="p1", image_tag=TAG, state="claimed", claimed_by="conv-a", bound_to_pod=False)]
    sboxes = [SandboxRef(conv_id="conv-a", image_tag=TAG, suspended=True, clean_unmount=False)]
    actions = reconcile(pvcs=pvcs, sandboxes=sboxes, cfg=cfg(min_ready=0))
    assert any(isinstance(a, DeletePvc) and a.pvc == "p1" for a in actions)
    assert not any(isinstance(a, Relabel) and a.pvc == "p1" and a.state == "ready" for a in actions)


def test_no_return_while_pod_still_bound():
    # Suspended flag set but a pod still holds the RWO PVC -> wait (don't relabel yet;
    # relabeling `ready` could let a second pod claim it while the first is unmounting).
    pvcs = [PoolPvc(name="p1", image_tag=TAG, state="claimed", claimed_by="conv-a", bound_to_pod=True)]
    sboxes = [SandboxRef(conv_id="conv-a", image_tag=TAG, suspended=True, clean_unmount=True)]
    actions = reconcile(pvcs=pvcs, sandboxes=sboxes, cfg=cfg(min_ready=1))
    assert not any(isinstance(a, Relabel) and a.pvc == "p1" for a in actions)


# --- leak recovery ---------------------------------------------------------

def test_leak_recovery_claimed_pvc_with_no_sandbox():
    # A claimed PVC whose owning Sandbox no longer exists AND no pod holds it -> return
    # to `ready` (the sandbox died without a clean return).
    pvcs = [PoolPvc(name="p1", image_tag=TAG, state="claimed", claimed_by="ghost", bound_to_pod=False)]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=1))
    rels = [a for a in actions if isinstance(a, Relabel) and a.pvc == "p1"]
    assert rels and rels[0].state == "ready"


def test_no_leak_recovery_while_pod_bound():
    # Orphaned label but a pod still mounts it -> NOT a leak; leave it (the pod is alive).
    pvcs = [PoolPvc(name="p1", image_tag=TAG, state="claimed", claimed_by="ghost", bound_to_pod=True)]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=1))
    assert not any(isinstance(a, Relabel) and a.pvc == "p1" for a in actions)


# --- LRU eviction ----------------------------------------------------------

def test_lru_evicts_ready_past_max_total():
    # More ready PVCs than max_total for the current tag -> evict the coldest (oldest
    # last-used) down to max_total. 3 ready, max_total=2 -> delete 1 (the oldest).
    pvcs = [
        PoolPvc(name="r-old", image_tag=TAG, state="ready", last_used="2026-08-01T00:00:00Z"),
        PoolPvc(name="r-mid", image_tag=TAG, state="ready", last_used="2026-08-05T00:00:00Z"),
        PoolPvc(name="r-new", image_tag=TAG, state="ready", last_used="2026-08-10T00:00:00Z"),
    ]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=0, max_total=2))
    dels = [a for a in actions if isinstance(a, DeletePvc)]
    assert len(dels) == 1
    assert dels[0].pvc == "r-old"  # coldest evicted


def test_no_evict_within_max_total():
    pvcs = [PoolPvc(name="r1", image_tag=TAG, state="ready", last_used="2026-08-10T00:00:00Z")]
    actions = reconcile(pvcs=pvcs, sandboxes=[], cfg=cfg(min_ready=0, max_total=2))
    assert not any(isinstance(a, DeletePvc) for a in actions)


# --- combined: a claimed current-tag PVC in active use is left alone --------

def test_active_claimed_pvc_is_noop():
    pvcs = [PoolPvc(name="p1", image_tag=TAG, state="claimed", claimed_by="conv-a", bound_to_pod=True)]
    sboxes = [SandboxRef(conv_id="conv-a", image_tag=TAG, suspended=False)]
    actions = reconcile(pvcs=pvcs, sandboxes=sboxes, cfg=cfg(min_ready=0))
    # No warm (min_ready=0), no delete, no relabel for the active PVC.
    assert not any(isinstance(a, (DeletePvc,)) and getattr(a, "pvc", None) == "p1" for a in actions)
    assert not any(isinstance(a, Relabel) and a.pvc == "p1" for a in actions)
