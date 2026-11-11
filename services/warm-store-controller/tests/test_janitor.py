"""Upkeep decisions for one pass, against plain data."""

from warm_store_controller import janitor as j
from warm_store_controller.allocate import PoolPv

NOW = 1_800_000_000.0
CFG = j.UpkeepConfig(current_tag="t", pool_class="pool", reserve_grace=600, marker_retries=3)


def world(pvs=(), pvcs=(), sandboxes=(), mounted=(), warm_jobs=None, markers=None) -> j.World:
    return j.World(
        pvs=list(pvs),
        pvcs={p.name: p for p in pvcs},
        sandboxes={s.name: s for s in sandboxes},
        mounted=set(mounted),
        warm_jobs=warm_jobs or {},
        markers=markers or {},
    )


def run(w: j.World, attempts=None):
    return j.plan_upkeep(w, CFG, NOW, attempts or {})


def overlay(sandbox, *, release=False, volume="pv1", sc="pool") -> j.Pvc:
    labels = {j.LBL_RELEASE: "requested"} if release else {}
    return j.Pvc(f"scooter-rw-{sandbox}", "Bound" if volume else "Pending", volume, sc, labels)


# --- PVs ------------------------------------------------------------------------

def test_bound_pv_is_labeled_with_its_sandbox_and_tag_and_leaves_its_pool():
    pv = PoolPv("pv1", phase="Bound", claim_ref="scooter-rw-conv-a", pool="warm")
    actions, _ = run(world([pv], sandboxes=[j.Sandbox("conv-a", "t", False)]))
    assert actions == [j.LabelPv(pv, "t", "conv-a", False)]


def test_labeled_bound_pv_is_left_alone():
    pv = PoolPv("pv1", image_tag="t", phase="Bound", claim_ref="scooter-rw-conv-a", last_sandbox="conv-a")
    assert run(world([pv], sandboxes=[j.Sandbox("conv-a", "t", False)]))[0] == []


def test_a_mounted_pv_loses_a_stale_clean_mark():
    pv = PoolPv("pv1", image_tag="t", phase="Bound", claim_ref="scooter-rw-conv-a", last_sandbox="conv-a", shutdown_clean=True)
    actions, _ = run(world([pv], sandboxes=[j.Sandbox("conv-a", "t", False)], mounted=["scooter-rw-conv-a"]))
    assert actions == [j.LabelPv(pv, "t", "conv-a", True)]


def test_clean_released_pv_is_recycled_into_its_pool():
    sandbox_pv = PoolPv("pv1", image_tag="t", phase="Released", claim_ref="scooter-rw-conv-a", shutdown_clean=True)
    warm_pv = PoolPv("pv2", image_tag="t", phase="Released", claim_ref="warm-store-t-abc", shutdown_clean=True)
    actions, _ = run(world([sandbox_pv, warm_pv]))
    assert actions == [j.Recycle(sandbox_pv, "returned"), j.Recycle(warm_pv, "warm")]


def test_unchecked_or_old_tag_released_pvs_are_retired():
    unchecked = PoolPv("pv1", image_tag="t", phase="Released", claim_ref="scooter-rw-conv-a")
    old = PoolPv("pv2", image_tag="old", phase="Released", claim_ref="scooter-rw-conv-b", shutdown_clean=True)
    actions, _ = run(world([unchecked, old]))
    assert actions == [j.RetirePv(unchecked, "released-unchecked"), j.RetirePv(old, "retired-tag")]


def test_idle_pvs_of_a_retired_tag_or_with_no_pool_are_retired():
    old = PoolPv("pv1", image_tag="old", phase="Available", pool="warm")
    unpooled = PoolPv("pv2", image_tag="t", phase="Available")
    fine = PoolPv("pv3", image_tag="t", phase="Available", pool="warm")
    actions, _ = run(world([old, unpooled, fine]))
    assert actions == [j.RetirePv(old, "retired-tag"), j.RetirePv(unpooled, "unpooled")]


def test_pvs_already_being_wiped_are_skipped():
    pv = PoolPv("pv1", image_tag="old", phase="Released", reclaim_policy="Delete")
    assert run(world([pv]))[0] == []


def test_stale_reservation_is_cleared_only_after_the_grace_period():
    def reserved(at):
        return PoolPv("pv1", image_tag="t", phase="Available", pool="warm", claim_ref="scooter-rw-conv-a", reserved_at=at)

    fresh = reserved("2027-01-15T07:59:00Z")  # NOW is 08:00:00Z
    assert run(world([fresh]))[0] == []
    old = reserved("2027-01-15T07:00:00Z")
    assert run(world([old]))[0] == [j.ClearReservation(old)]
    # Still waiting on a running sandbox's pending PVC: keep it.
    pending = overlay("conv-a", volume=None)
    assert run(world([old], pvcs=[pending], sandboxes=[j.Sandbox("conv-a", "t", False)]))[0] == []
    assert run(world([old], pvcs=[pending], sandboxes=[j.Sandbox("conv-a", "t", True)]))[0] == [j.ClearReservation(old)]


# --- releases ---------------------------------------------------------------------

POOL_PV = PoolPv("pv1", image_tag="t", phase="Bound", claim_ref="scooter-rw-conv-a", last_sandbox="conv-a")
SUSPENDED = j.Sandbox("conv-a", "t", True)


def release(**kw):
    w = world([POOL_PV], pvcs=[overlay("conv-a", release=True)], sandboxes=[kw.pop("sandbox", SUSPENDED)], **kw)
    return [a for a in run(w, kw.get("attempts"))[0] if not isinstance(a, j.LabelPv)]


def test_a_resumed_sandbox_keeps_its_pvc():
    assert release(sandbox=j.Sandbox("conv-a", "t", False)) == [j.Unrelease("scooter-rw-conv-a")]


def test_release_waits_for_the_pod_to_go():
    assert release(mounted=["scooter-rw-conv-a"]) == []


def test_release_starts_a_marker_check():
    assert release() == [j.StartMarkerCheck("scooter-rw-conv-a")]


def test_marker_results_finish_the_release():
    assert release(markers={"scooter-rw-conv-a": "running"}) == []
    assert release(markers={"scooter-rw-conv-a": "clean"}) == [j.FinishRelease("scooter-rw-conv-a", "pv1", True, "clean")]
    assert release(markers={"scooter-rw-conv-a": "dirty"}) == [
        j.FinishRelease("scooter-rw-conv-a", "pv1", False, "unclean-shutdown")
    ]
    assert release(markers={"scooter-rw-conv-a": "unknown"}) == [j.MarkerUnknown("scooter-rw-conv-a")]


def test_an_unreadable_volume_is_retired_after_the_retries():
    w = world([POOL_PV], pvcs=[overlay("conv-a", release=True)], sandboxes=[SUSPENDED])
    actions, _ = j.plan_upkeep(w, CFG, NOW, {"scooter-rw-conv-a": 3})
    assert j.FinishRelease("scooter-rw-conv-a", "pv1", False, "marker-unreadable") in actions


def test_legacy_and_unbound_pvcs_are_just_deleted():
    legacy = overlay("conv-a", release=True, volume="pv-local", sc="local-path")
    unbound = overlay("conv-b", release=True, volume=None)
    w = world([], pvcs=[legacy, unbound], sandboxes=[SUSPENDED, j.Sandbox("conv-b", "t", True)])
    assert run(w)[0] == [
        j.DropRelease("scooter-rw-conv-a", "release-legacy"),
        j.DropRelease("scooter-rw-conv-b", "release-unbound"),
    ]


# --- warm PVCs ----------------------------------------------------------------------

def warm_pvc(name="warm-store-t-1", tag="t", volume="pv9", created=NOW - 10) -> j.Pvc:
    return j.Pvc(name, "Bound", volume, "pool", {j.LBL_WARM_SEED: "true", "scooter.io/warm-store": tag}, created_at=created)


def test_warm_pvcs_follow_their_job():
    w = world(pvcs=[warm_pvc()], warm_jobs={"warm-store-t-1": j.WarmJob("running", "n1")})
    assert run(w) == ([], ["n1"])
    w = world(pvcs=[warm_pvc()], warm_jobs={"warm-store-t-1": j.WarmJob("succeeded", "n1")})
    assert run(w) == ([j.PromoteWarm("warm-store-t-1", "pv9")], ["n1"])
    w = world(pvcs=[warm_pvc()], warm_jobs={"warm-store-t-1": j.WarmJob("failed")})
    assert run(w)[0] == [j.DeletePvc("warm-store-t-1", "warm-failed")]


def test_warm_pvcs_of_a_retired_tag_or_without_a_job_are_dropped():
    assert run(world(pvcs=[warm_pvc(tag="old")]))[0] == [j.DeletePvc("warm-store-t-1", "retired-tag")]
    assert run(world(pvcs=[warm_pvc(created=NOW - 10)])) == ([], [None])
    assert run(world(pvcs=[warm_pvc(created=NOW - 1000)]))[0] == [j.DeletePvc("warm-store-t-1", "warm-orphan")]


# --- warm PVs in flight still count (#973) -------------------------------------

def test_a_promoting_warm_pvc_still_counts_as_warming():
    pvc = j.Pvc("warm-store-t-1", "Bound", "pv9", "pool", {j.LBL_WARM_SEED: "true", "scooter.io/warm-store": "t"},
                terminating=True)
    pv = PoolPv("pv9", image_tag="t", phase="Bound", claim_ref="warm-store-t-1",
                node_selector_terms=[{"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": ["n1"]}]}])
    actions, warming = run(world([pv], pvcs=[pvc]))
    assert warming == ["n1"]


def test_a_terminating_warm_pvc_of_an_old_tag_does_not_count():
    pvc = j.Pvc("warm-store-old-1", "Bound", "pv9", "pool", {j.LBL_WARM_SEED: "true", "scooter.io/warm-store": "old"},
                terminating=True)
    assert run(world(pvcs=[pvc]))[1] == []


def test_a_warm_pv_recycled_this_pass_counts_as_warming():
    pv = PoolPv("pv9", image_tag="t", phase="Released", claim_ref="warm-store-t-1", shutdown_clean=True)
    actions, warming = run(world([pv]))
    assert actions == [j.Recycle(pv, "warm")]
    assert warming == [None]
