"""Tier 1 — the PV-placement phase of the reconcile loop, against a fake k8s.

Locks the behaviours that keep the pool an OPTIMIZATION rather than a dependency: every
failure path still lets the sandbox's vct provision, a half-applied reservation rolls
back, and nothing is ever double-booked.
"""

from warm_store_controller.allocate import Node, PendingSandbox, PoolPv
from warm_store_controller.loop import reconcile_once
from warm_store_controller.reconcile import PoolConfig
from warm_store_controller.reservations import Reservations

TAG = "abc123def456"
CFG = PoolConfig(current_image_tag=TAG, min_ready=0, max_total=8)


class FakeK8s:
    """Only the PV-layer surface; the PVC-layer calls return empty so the earlier phase is
    a no-op and these tests isolate placement."""

    def __init__(self, pvs=(), nodes=(), pending=(), fail_reserve=False, fail_list=False):
        self._pvs = list(pvs)
        self._nodes = list(nodes) or [Node(name="odin", labels={"kubernetes.io/hostname": "odin"})]
        self._pending = list(pending)
        self._fail_reserve = fail_reserve
        self._fail_list = fail_list
        self.reserved = []   # [(pv, pvc, sandbox)]
        self.released = []   # [pv]

    # PVC-layer (unused here)
    def list_pool_pvcs(self):
        return []

    def list_sandboxes(self):
        return []

    # PV-layer
    def list_pool_pvs(self):
        if self._fail_list:
            raise RuntimeError("api down")
        return list(self._pvs)

    def list_nodes(self):
        return list(self._nodes)

    def list_pending_uppers(self):
        return list(self._pending)

    def reserve_pv(self, pv, pvc_name, sandbox):
        if self._fail_reserve:
            raise RuntimeError("patch rejected")
        self.reserved.append((pv, pvc_name, sandbox))

    def release_pv(self, pv):
        self.released.append(pv)


def pv(name, **kw):
    return PoolPv(name=name, image_tag=kw.pop("image_tag", TAG), phase=kw.pop("phase", "Available"), **kw)


def want(sandbox):
    return PendingSandbox(sandbox=sandbox, image_tag=TAG, pvc_name=f"scooter-rw-{sandbox}")


def test_places_a_warm_pv_and_holds_it_in_flight():
    k8s = FakeK8s(pvs=[pv("warm-1")], pending=[want("conv-a")])
    res = Reservations()
    out = reconcile_once(k8s, CFG, res)
    assert k8s.reserved == [("warm-1", "scooter-rw-conv-a", "conv-a")]
    assert ("warm-1", "reserve-pv") in out
    # Held so the NEXT pass cannot select it before the binding is visible.
    assert res.active() == {"warm-1"}


def test_a_COLD_pool_falls_through_to_the_vct():
    k8s = FakeK8s(pvs=[], pending=[want("conv-a")])
    out = reconcile_once(k8s, CFG, Reservations())
    assert k8s.reserved == []
    assert ("conv-a", "vct-provision") in out


def test_an_UNREACHABLE_pv_falls_through_to_the_vct():
    # Node-local (or EBS-AZ) mismatch: the pool is non-empty but topologically useless.
    on_thor = pv("warm-1", node_selector_terms=[
        {"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": ["thor"]}]}
    ])
    k8s = FakeK8s(pvs=[on_thor], pending=[want("conv-a")])
    out = reconcile_once(k8s, CFG, Reservations())
    assert k8s.reserved == []
    assert ("conv-a", "vct-provision") in out


def test_a_FAILED_reservation_ROLLS_BACK_and_does_not_leak_the_pv():
    # Without rollback the fallback loop leaks a pool volume on every miss.
    k8s = FakeK8s(pvs=[pv("warm-1")], pending=[want("conv-a")], fail_reserve=True)
    res = Reservations()
    reconcile_once(k8s, CFG, res)
    assert k8s.released == ["warm-1"]      # claimRef cleared
    assert res.active() == set()           # hold dropped


def test_a_LISTING_failure_never_blocks_a_conversation():
    k8s = FakeK8s(fail_list=True, pending=[want("conv-a")])
    out = reconcile_once(k8s, CFG, Reservations())  # must not raise
    assert k8s.reserved == []
    assert out == []


def test_released_pvs_are_recycled_before_allocating():
    # A PV freed this pass must be usable in the SAME pass, not one interval later.
    k8s = FakeK8s(pvs=[pv("done", phase="Released")], pending=[])
    out = reconcile_once(k8s, CFG, Reservations())
    assert k8s.released == ["done"]
    assert ("done", "release-pv") in out


def test_two_pending_sandboxes_never_share_a_pv():
    k8s = FakeK8s(pvs=[pv("only-one")], pending=[want("conv-a"), want("conv-b")])
    out = reconcile_once(k8s, CFG, Reservations())
    assert len(k8s.reserved) == 1
    assert sum(1 for _, kind in out if kind == "vct-provision") == 1


def test_an_IN_FLIGHT_pv_is_not_re_placed_on_the_next_pass():
    k8s = FakeK8s(pvs=[pv("warm-1")], pending=[want("conv-a")])
    res = Reservations()
    reconcile_once(k8s, CFG, res)
    # Same PV still reads Available (the binding has not landed) — a second pass must not
    # hand it to another sandbox.
    k8s._pending = [want("conv-b")]
    out = reconcile_once(k8s, CFG, res)
    assert len(k8s.reserved) == 1
    assert ("conv-b", "vct-provision") in out


def test_placement_is_SKIPPED_entirely_without_a_reservation_set():
    # The safe degrade: older call sites keep working and simply do no placement.
    k8s = FakeK8s(pvs=[pv("warm-1")], pending=[want("conv-a")])
    out = reconcile_once(k8s, CFG)
    assert k8s.reserved == []
    assert out == []
