"""Tier 1 — the in-flight reservation set (no cluster, fake clock)."""

from warm_store_controller.reservations import Reservations


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def time(self) -> float:
        return self.now

    def advance(self, secs: float) -> None:
        self.now += secs


def test_a_claimed_pv_is_active():
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    assert r.claim("pv-a") is True
    assert r.active() == {"pv-a"}


def test_THE_MUTUAL_EXCLUSION_a_second_claim_LOSES():
    # The core guarantee: claim() is test-and-set under one lock, so exactly one caller
    # can own a PV. Check-then-act (ask active(), then reserve) would let both through.
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    assert r.claim("pv-a") is True
    assert r.claim("pv-a") is False


def test_an_EXPIRED_hold_can_be_re_claimed():
    # A controller that died mid-decision must not strand the volume forever.
    clock = FakeClock()
    r = Reservations(ttl_seconds=60, clock=clock)
    assert r.claim("pv-a") is True
    clock.advance(61)
    assert r.claim("pv-a") is True


def test_a_confirmed_pv_can_be_claimed_again():
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    r.claim("pv-a")
    r.confirm("pv-a")
    assert r.claim("pv-a") is True


def test_concurrent_claims_yield_exactly_ONE_winner():
    # Hammer it from many threads: the invariant is one winner, never two.
    import threading

    r = Reservations(ttl_seconds=60, clock=FakeClock())
    wins, lock = [], threading.Lock()
    start = threading.Barrier(16)

    def go():
        start.wait()
        if r.claim("contested"):
            with lock:
                wins.append(1)

    threads = [threading.Thread(target=go) for _ in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(wins) == 1


def test_confirm_drops_the_hold():
    # Once the binding is visible, the PV's own claimRef excludes it — the local hold is
    # redundant and must not linger.
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    r.claim("pv-a")
    r.confirm("pv-a")
    assert r.active() == set()


def test_release_rolls_back_a_failed_reservation():
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    r.claim("pv-a")
    r.release("pv-a")
    assert r.active() == set()


def test_THE_LEAK_GUARD_a_reservation_expires():
    # A controller that dies between reserve and observe would otherwise strand this PV
    # as permanently in-flight: never allocated, never reclaimed, invisible to the pool.
    clock = FakeClock()
    r = Reservations(ttl_seconds=60, clock=clock)
    r.claim("pv-a")
    clock.advance(59)
    assert r.active() == {"pv-a"}
    clock.advance(2)
    assert r.active() == set()


def test_expiry_is_per_pv():
    clock = FakeClock()
    r = Reservations(ttl_seconds=60, clock=clock)
    r.claim("old")
    clock.advance(40)
    r.claim("new")
    clock.advance(30)  # old is 70s in (expired), new is 30s in
    assert r.active() == {"new"}


def test_confirming_an_unknown_pv_is_a_noop():
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    r.confirm("never-seen")  # must not raise
    assert r.active() == set()


def test_len_reflects_live_holds_only():
    clock = FakeClock()
    r = Reservations(ttl_seconds=60, clock=clock)
    r.claim("a")
    r.claim("b")
    assert len(r) == 2
    clock.advance(61)
    assert len(r) == 0


def test_confirm_stays_IDEMPOTENT():
    # Deliberate asymmetry: refresh() extends an exclusive right and must prove it holds
    # one; confirm() only gives one up, and the loop calls it every pass for every
    # realised PVC, so "already released" is the steady state, not an error.
    r = Reservations(ttl_seconds=60, clock=FakeClock())
    r.claim("pv-a")
    r.confirm("pv-a")
    r.confirm("pv-a")  # must not raise
    assert r.active() == set()
