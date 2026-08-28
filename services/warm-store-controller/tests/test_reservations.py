"""Tier 1 — the in-flight reservation set (no cluster, fake clock)."""

from warm_store_controller.reservations import Reservations


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def time(self) -> float:
        return self.now

    def advance(self, secs: float) -> None:
        self.now += secs


def test_a_reserved_pv_is_active():
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    r.reserve("pv-a")
    assert r.active() == {"pv-a"}


def test_confirm_drops_the_hold():
    # Once the binding is visible, the PV's own claimRef excludes it — the local hold is
    # redundant and must not linger.
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    r.reserve("pv-a")
    r.confirm("pv-a")
    assert r.active() == set()


def test_release_rolls_back_a_failed_reservation():
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    r.reserve("pv-a")
    r.release("pv-a")
    assert r.active() == set()


def test_THE_LEAK_GUARD_a_reservation_expires():
    # A controller that dies between reserve and observe would otherwise strand this PV
    # as permanently in-flight: never allocated, never reclaimed, invisible to the pool.
    clock = FakeClock()
    r = Reservations(ttl_seconds=60, clock=clock)
    r.reserve("pv-a")
    clock.advance(59)
    assert r.active() == {"pv-a"}
    clock.advance(2)
    assert r.active() == set()


def test_re_reserving_REFRESHES_the_deadline():
    # A PV we keep choosing (binding still not visible) must not expire mid-flight.
    clock = FakeClock()
    r = Reservations(ttl_seconds=60, clock=clock)
    r.reserve("pv-a")
    clock.advance(50)
    r.reserve("pv-a")
    clock.advance(50)
    assert r.active() == {"pv-a"}


def test_expiry_is_per_pv():
    clock = FakeClock()
    r = Reservations(ttl_seconds=60, clock=clock)
    r.reserve("old")
    clock.advance(40)
    r.reserve("new")
    clock.advance(30)  # old is 70s in (expired), new is 30s in
    assert r.active() == {"new"}


def test_confirming_an_unknown_pv_is_a_noop():
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    r.confirm("never-seen")  # must not raise
    assert r.active() == set()


def test_len_reflects_live_holds_only():
    clock = FakeClock()
    r = Reservations(ttl_seconds=60, clock=clock)
    r.reserve("a")
    r.reserve("b")
    assert len(r) == 2
    clock.advance(61)
    assert len(r) == 0
