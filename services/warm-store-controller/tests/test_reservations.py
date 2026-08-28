"""Tier 1 — in-flight (sandbox ↔ PV) reservations (no cluster, fake clock).

A reservation is a PAIR, and both directions are enforced: one PV never goes to two
sandboxes, and one sandbox never holds two PVs.
"""

import threading

import pytest

from warm_store_controller.reservations import AlreadyClaimed, Reservations


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def time(self) -> float:
        return self.now

    def advance(self, secs: float) -> None:
        self.now += secs


def res(ttl=60, clock=None):
    return Reservations(ttl_seconds=ttl, clock=clock or FakeClock())


# --- the pair --------------------------------------------------------------

def test_a_claim_records_BOTH_directions():
    r = res()
    got = r.claim("pv-a", "conv-1")
    assert (got.pv, got.sandbox) == ("pv-a", "conv-1")
    assert r.get_pv_owner("pv-a") == "conv-1"
    assert r.get_pv_for_pod("conv-1") == "pv-a"
    assert r.in_flight_reservations() == {"pv-a"}


def test_ONE_PV_ONE_SANDBOX_a_second_sandbox_is_refused():
    # Two sandboxes on one overlay upper is store corruption; RWO does not prevent a
    # same-node double-mount, so this is the guard that does.
    r = res()
    r.claim("pv-a", "conv-1")
    with pytest.raises(AlreadyClaimed, match="already claimed by sandbox 'conv-1'"):
        r.claim("pv-a", "conv-2")


def test_ONE_SANDBOX_ONE_PV_a_second_volume_is_refused():
    # The first PV would be stranded: claimRef'd to a PVC nobody creates, withheld from
    # the pool until its TTL lapses.
    r = res()
    r.claim("pv-a", "conv-1")
    with pytest.raises(AlreadyClaimed, match="already holds 'pv-a'"):
        r.claim("pv-b", "conv-1")


def test_re_claiming_the_SAME_pair_is_idempotent_and_refreshes():
    # The only way to extend a hold — and only a caller that can name the pair it already
    # owns can do it. A sandbox we keep choosing must not expire mid-flight.
    clock = FakeClock()
    r = res(clock=clock)
    r.claim("pv-a", "conv-1")
    clock.advance(50)
    r.claim("pv-a", "conv-1")
    clock.advance(50)
    assert r.in_flight_reservations() == {"pv-a"}  # would have lapsed at 60 without the refresh


def test_a_released_pv_can_go_to_a_DIFFERENT_sandbox():
    r = res()
    r.claim("pv-a", "conv-1")
    r.release("pv-a")
    r.claim("pv-a", "conv-2")
    assert r.get_pv_owner("pv-a") == "conv-2"


def test_a_released_sandbox_can_take_a_DIFFERENT_pv():
    r = res()
    r.claim("pv-a", "conv-1")
    r.release("pv-a")
    r.claim("pv-b", "conv-1")
    assert r.get_pv_for_pod("conv-1") == "pv-b"


# --- expiry ----------------------------------------------------------------

def test_THE_LEAK_GUARD_a_reservation_expires():
    # A controller dying between claim and observe would otherwise strand this PV as
    # permanently in-flight: never allocated, never reclaimed, invisible to the pool.
    clock = FakeClock()
    r = res(clock=clock)
    r.claim("pv-a", "conv-1")
    clock.advance(59)
    assert r.in_flight_reservations() == {"pv-a"}
    clock.advance(2)
    assert r.in_flight_reservations() == set()


def test_an_EXPIRED_reservation_frees_BOTH_sides():
    clock = FakeClock()
    r = res(clock=clock)
    r.claim("pv-a", "conv-1")
    clock.advance(61)
    assert r.get_pv_owner("pv-a") is None
    assert r.get_pv_for_pod("conv-1") is None
    r.claim("pv-a", "conv-2")          # the PV is free for another sandbox...
    r.claim("pv-b", "conv-1")          # ...and conv-1 is free to take another PV
    assert r.get_pv_owner("pv-a") == "conv-2"
    assert r.get_pv_for_pod("conv-1") == "pv-b"


def test_expiry_is_per_reservation():
    clock = FakeClock()
    r = res(clock=clock)
    r.claim("old", "conv-1")
    clock.advance(40)
    r.claim("new", "conv-2")
    clock.advance(30)  # old is 70s in (expired), new is 30s in
    assert r.in_flight_reservations() == {"new"}


def test_expiring_a_stale_entry_does_not_clobber_the_sandboxs_LIVE_one():
    # conv-1's first PV lapses, then it legitimately takes another. Sweeping the stale
    # entry must not drop the live reverse-index entry with it.
    clock = FakeClock()
    r = res(clock=clock)
    r.claim("pv-old", "conv-1")
    clock.advance(61)
    r.claim("pv-new", "conv-1")
    assert r.get_pv_for_pod("conv-1") == "pv-new"
    r.in_flight_reservations()  # force a sweep
    assert r.get_pv_for_pod("conv-1") == "pv-new"


# --- release ---------------------------------------------------------------

def test_release_drops_the_reservation_both_ways():
    r = res()
    r.claim("pv-a", "conv-1")
    r.release("pv-a")
    assert r.in_flight_reservations() == set()
    assert r.get_pv_owner("pv-a") is None
    assert r.get_pv_for_pod("conv-1") is None


def test_release_rolls_back_a_failed_reservation():
    r = res()
    r.claim("pv-a", "conv-1")
    r.release("pv-a")
    assert r.in_flight_reservations() == set()


def test_release_stays_IDEMPOTENT():
    # Deliberate asymmetry with claim(): the loop calls release for every realised PVC on
    # every pass, so "already released" is the steady state, not an error.
    r = res()
    r.claim("pv-a", "conv-1")
    r.release("pv-a")
    r.release("pv-a")
    r.release("never-seen")
    assert r.in_flight_reservations() == set()


# --- concurrency -----------------------------------------------------------

def test_concurrent_claims_on_one_PV_yield_exactly_ONE_winner():
    r = res()
    wins, lock = [], threading.Lock()
    start = threading.Barrier(16)

    def go(i):
        start.wait()
        try:
            r.claim("contested", f"conv-{i}")
        except AlreadyClaimed:
            return
        with lock:
            wins.append(i)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(wins) == 1
    assert r.get_pv_owner("contested") == f"conv-{wins[0]}"


def test_concurrent_claims_by_one_SANDBOX_yield_exactly_ONE_winner():
    # The other direction: one sandbox racing for several PVs must end up holding one.
    r = res()
    wins, lock = [], threading.Lock()
    start = threading.Barrier(16)

    def go(i):
        start.wait()
        try:
            r.claim(f"pv-{i}", "conv-1")
        except AlreadyClaimed:
            return
        with lock:
            wins.append(i)

    threads = [threading.Thread(target=go, args=(i,)) for i in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(wins) == 1
    assert r.get_pv_for_pod("conv-1") == f"pv-{wins[0]}"
