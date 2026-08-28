"""Tier 1 — the PV-placement phase of the reconcile loop, against a fake k8s.

Locks the behaviours keeping the pool an optimization, not a dependency."""

import pytest
from kubernetes.client.exceptions import ApiException

from warm_store_controller.allocate import Node, PendingSandbox, PoolPv
from warm_store_controller.loop import reconcile_once
from warm_store_controller.reconcile import PoolConfig
from warm_store_controller.reservations import Reservations

TAG = "abc123def456"
CFG = PoolConfig(current_image_tag=TAG, min_ready=0, max_total=8)


class FakeK8s:
    """Only the PV-layer surface; the PVC-layer calls return empty so the earlier phase is
    a no-op and these tests isolate placement."""

    def __init__(self, pvs=(), nodes=(), pending=(), fail_reserve=False, fail_list=False, fail_reserve_for=()):
        self._pvs = list(pvs)
        self._nodes = list(nodes) or [Node(name="odin", labels={"kubernetes.io/hostname": "odin"})]
        self._pending = list(pending)
        self._fail_reserve = fail_reserve
        self._fail_reserve_for = set(fail_reserve_for)
        self._fail_list = fail_list
        self.reserved = []   # [(pv, pvc, sandbox)]
        self.released = []   # [pv]
        self.node_lists = 0  # how many times we asked the API for nodes

    # PVC-layer (unused here)
    def list_pool_pvcs(self):
        return []

    def list_sandboxes(self):
        return []

    # PV-layer
    def iter_pool_pvs(self):
        if self._fail_list:
            raise ApiException(status=503, reason="Service Unavailable")
        # A GENERATOR, like the real one.
        yield from self._pvs

    def list_nodes(self):
        self.node_lists += 1
        return list(self._nodes)

    def list_pending_uppers(self):
        return list(self._pending)

    def reserve_pv(self, pv, pvc_name, sandbox):
        if self._fail_reserve or pv in self._fail_reserve_for:
            raise ApiException(status=409, reason="Conflict")
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
    reconcile_once(k8s, CFG, res, {})
    assert k8s.reserved == [("warm-1", "scooter-rw-conv-a", "conv-a")]
    # Held so the NEXT pass cannot select it before the binding is visible.
    assert res.in_flight_reservations() == {"warm-1"}


def test_a_COLD_pool_falls_through_to_the_vct():
    k8s = FakeK8s(pvs=[], pending=[want("conv-a")])
    reconcile_once(k8s, CFG, Reservations(), {})
    assert k8s.reserved == []


def test_an_UNREACHABLE_pv_falls_through_to_the_vct():
    # Node-local (or EBS-AZ) mismatch: the pool is non-empty but topologically useless.
    on_thor = pv("warm-1", node_selector_terms=[
        {"matchExpressions": [{"key": "kubernetes.io/hostname", "operator": "In", "values": ["thor"]}]}
    ])
    k8s = FakeK8s(pvs=[on_thor], pending=[want("conv-a")])
    reconcile_once(k8s, CFG, Reservations(), {})
    assert k8s.reserved == []


def test_a_FAILED_reservation_ROLLS_BACK_and_does_not_leak_the_pv():
    # Without rollback the fallback loop leaks a pool volume on every miss.
    k8s = FakeK8s(pvs=[pv("warm-1")], pending=[want("conv-a")], fail_reserve=True)
    res = Reservations()
    reconcile_once(k8s, CFG, res, {})
    assert k8s.released == ["warm-1"]      # claimRef cleared
    assert res.in_flight_reservations() == set()           # hold dropped


def test_a_LISTING_failure_never_blocks_a_conversation():
    k8s = FakeK8s(fail_list=True, pending=[want("conv-a")])
    reconcile_once(k8s, CFG, Reservations(), {})  # must not raise
    assert k8s.reserved == []


def test_released_pvs_are_recycled_before_allocating():
    # A PV freed this pass must be usable in the SAME pass, not one interval later.
    k8s = FakeK8s(pvs=[pv("done", phase="Released")], pending=[])
    reconcile_once(k8s, CFG, Reservations(), {})
    assert k8s.released == ["done"]


def test_two_pending_sandboxes_never_share_a_pv():
    k8s = FakeK8s(pvs=[pv("only-one")], pending=[want("conv-a"), want("conv-b")])
    reconcile_once(k8s, CFG, Reservations(), {})
    assert len(k8s.reserved) == 1   # the other sandbox fell through to its vct


def test_an_IN_FLIGHT_pv_is_not_re_placed_on_the_next_pass():
    k8s = FakeK8s(pvs=[pv("warm-1")], pending=[want("conv-a")])
    res = Reservations()
    reconcile_once(k8s, CFG, res, {})
    # Still reads Available (binding not landed) — a second pass must not re-hand it.
    k8s._pending = [want("conv-b")]
    reconcile_once(k8s, CFG, res, {})
    assert len(k8s.reserved) == 1   # conv-b fell through to its vct


def test_an_IDLE_cluster_does_not_list_nodes():
    # Nothing pending -> skip the node listing; an idle cluster should not pay for it.
    k8s = FakeK8s(pvs=[pv("warm-1")], pending=[])
    reconcile_once(k8s, CFG, Reservations(), {})
    assert k8s.node_lists == 0


def test_placement_consumes_the_pool_in_the_order_the_shell_yields_it():
    # The shell yields MRU-first, so the first usable candidate is the best one.
    k8s = FakeK8s(
        pvs=[pv("hot", last_used="2026-08-27T10:00:00Z"), pv("cold", last_used="2026-01-01T00:00:00Z")],
        pending=[want("conv-a")],
    )
    reconcile_once(k8s, CFG, Reservations(), {})
    assert k8s.reserved[0][0] == "hot"


def test_a_pv_ALREADY_claimed_in_flight_is_not_re_written():
    # claim() is the gate: a PV held elsewhere is never patched, we fall back to the vct.
    k8s = FakeK8s(pvs=[pv("warm-1")], pending=[want("conv-a")])
    res = Reservations()
    res.claim("warm-1", "conv-other")  # somebody else got there first
    reconcile_once(k8s, CFG, res, {})
    assert k8s.reserved == []


def test_a_REALISED_pvc_drops_the_in_process_hold():
    # The PV's claimRef now excludes it; without cleanup the hold lingers to its TTL.
    k8s = FakeK8s(pvs=[pv("warm-1")], pending=[want("conv-a")])
    res = Reservations()
    reconcile_once(k8s, CFG, res, {})
    assert res.in_flight_reservations() == {"warm-1"}          # held while the PVC is still pending
    # Next pass: the PVC is realised (claimRef set) and no longer pending.
    k8s._pvs = [pv("warm-1", phase="Bound", claim_ref="scooter-rw-conv-a")]
    k8s._pending = []
    reconcile_once(k8s, CFG, res, {})
    assert res.in_flight_reservations() == set()               # hold released


def test_a_NON_api_error_is_NOT_swallowed():
    # ApiException degrades to the vct; OUR bugs must surface, not look like a cold pool.
    class Boom(FakeK8s):
        def list_pending_uppers(self):
            raise TypeError("bug in our own code")

    with pytest.raises(TypeError):
        reconcile_once(Boom(pvs=[pv("warm-1")]), CFG, Reservations(), {})


def test_losing_a_race_FALLS_THROUGH_to_the_next_candidate():
    # Selfish selection's payoff: a contended PV costs the next-best, not the placement.
    k8s = FakeK8s(
        pvs=[pv("hot", last_used="2026-08-27T10:00:00Z"), pv("cold", last_used="2026-01-01T00:00:00Z")],
        pending=[want("conv-a")],
    )
    res = Reservations()
    res.claim("hot", "conv-other")  # the best candidate is taken
    reconcile_once(k8s, CFG, res, {})
    assert k8s.reserved == [("cold", "scooter-rw-conv-a", "conv-a")]


def test_a_BROKEN_pv_does_not_cost_the_whole_placement():
    # Roll back the broken candidate and try the next, not straight to the vct.
    k8s = FakeK8s(
        pvs=[pv("bad", last_used="2026-08-27T10:00:00Z"), pv("good", last_used="2026-01-01T00:00:00Z")],
        pending=[want("conv-a")],
        fail_reserve_for={"bad"},
    )
    res = Reservations()
    reconcile_once(k8s, CFG, res, {})
    assert k8s.released == ["bad"]                       # rolled back
    assert k8s.reserved == [("good", "scooter-rw-conv-a", "conv-a")]
    assert res.get_pv_owner("bad") is None               # hold dropped


def test_every_candidate_exhausted_falls_back_to_the_vct():
    k8s = FakeK8s(pvs=[pv("only")], pending=[want("conv-a")], fail_reserve_for={"only"})
    reconcile_once(k8s, CFG, Reservations(), {})
    assert k8s.reserved == []   # every candidate failed -> the vct provisions


def test_affinity_is_recorded_at_BIND_time_not_reservation_time():
    # A reservation that never binds wrote nothing — see PR #403.
    aff: dict[str, str] = {}
    k8s = FakeK8s(pvs=[pv("warm-1")], pending=[want("conv-a")])
    reconcile_once(k8s, CFG, Reservations(), aff)
    assert aff == {}                                          # reserved, not yet bound
    # Next pass: the PVC is realised.
    k8s._pvs = [pv("warm-1", phase="Bound", claim_ref="scooter-rw-conv-a")]
    k8s._pending = []
    reconcile_once(k8s, CFG, Reservations(), aff)
    assert aff == {"conv-a": "warm-1"}


def test_X_RECLAIMS_A_after_Y_used_it():
    # X and Y are different KEYS, so Y binding A does not displace X. PR #403.
    aff: dict[str, str] = {}
    bound = lambda who: pv("A", phase="Bound", claim_ref=f"scooter-rw-{who}")

    for who in ("conv-x", "conv-y"):
        reconcile_once(FakeK8s(pvs=[bound(who)], pending=[]), CFG, Reservations(), aff)
    assert aff == {"conv-x": "A", "conv-y": "A"}

    # X asks again and gets A back, even though B was used more recently overall.
    k8s = FakeK8s(
        pvs=[pv("A", last_used="2026-01-01T00:00:00Z"), pv("B", last_used="2026-08-27T10:00:00Z")],
        pending=[want("conv-x")],
    )
    reconcile_once(k8s, CFG, Reservations(), aff)
    assert k8s.reserved == [("A", "scooter-rw-conv-x", "conv-x")]


def test_a_sandbox_that_moves_volumes_prefers_its_NEWEST():
    # The only overwrite the dict does, and it is correct: one sandbox, one current volume.
    aff: dict[str, str] = {}
    for vol in ("old", "new"):
        reconcile_once(
            FakeK8s(pvs=[pv(vol, phase="Bound", claim_ref="scooter-rw-conv-a")], pending=[]),
            CFG, Reservations(), aff,
        )
    assert aff == {"conv-a": "new"}


def test_a_TERMINATING_released_pv_is_left_alone():
    # Already resolved; touching it restarts the delete->terminating->re-read spin (#399).
    k8s = FakeK8s(pvs=[pv("dying", phase="Released", terminating=True)], pending=[])
    reconcile_once(k8s, CFG, Reservations(), {})
    assert k8s.released == []
