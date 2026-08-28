"""Tier 1 — the sandbox→PV affinity cache (no cluster)."""

from warm_store_controller.affinity import _NO_AFFINITY, Affinity


def test_a_recorded_pv_ranks_ahead_of_an_unknown_one():
    a = Affinity()
    a.record("pv-1", "conv-a")
    assert a.rank_of("pv-1", "conv-a") == 0
    assert a.rank_of("pv-other", "conv-a") == _NO_AFFINITY


def test_affinity_is_PER_SANDBOX():
    a = Affinity()
    a.record("pv-1", "conv-a")
    assert a.rank_of("pv-1", "conv-b") == _NO_AFFINITY


def test_THE_ANNOTATION_COULD_NOT_DO_THIS_two_sandboxes_both_prefer_one_pv():
    # X uses A, then Y uses A. A single-valued annotation would have overwritten X's
    # association permanently, sending X to a cold volume even though A holds its builds.
    a = Affinity()
    a.record("A", "conv-x")
    a.record("A", "conv-y")
    assert a.rank_of("A", "conv-x") < _NO_AFFINITY
    assert a.rank_of("A", "conv-y") < _NO_AFFINITY


def test_most_recent_use_ranks_first():
    a = Affinity()
    a.record("first", "conv-a")
    a.record("second", "conv-a")
    assert a.rank_of("second", "conv-a") < a.rank_of("first", "conv-a")


def test_re_recording_REFRESHES_rather_than_duplicating():
    # The loop sees the same bound PV every pass until release, so record() runs
    # repeatedly for ONE binding and must not grow the entry.
    a = Affinity(per_sandbox=2)
    a.record("x", "conv-a")
    a.record("y", "conv-a")
    for _ in range(5):
        a.record("x", "conv-a")
    assert a.rank_of("x", "conv-a") == 0
    assert a.rank_of("y", "conv-a") == 1


def test_history_is_bounded_per_sandbox():
    # A long tail of stale entries would outrank genuinely-hot volumes with cold ones.
    a = Affinity(per_sandbox=2)
    for name in ("one", "two", "three"):
        a.record(name, "conv-a")
    assert a.rank_of("one", "conv-a") == _NO_AFFINITY
    assert a.rank_of("three", "conv-a") == 0


def test_tracked_sandboxes_are_bounded_evicting_least_recent():
    a = Affinity(max_sandboxes=2)
    a.record("pv", "old")
    a.record("pv", "mid")
    a.record("pv", "new")
    assert a.rank_of("pv", "old") == _NO_AFFINITY
    assert a.rank_of("pv", "new") == 0


def test_forget_pv_clears_it_for_EVERY_sandbox():
    # The volume is gone; preferring it would rank something that no longer exists.
    a = Affinity()
    a.record("A", "conv-x")
    a.record("A", "conv-y")
    a.forget_pv("A")
    assert a.rank_of("A", "conv-x") == _NO_AFFINITY
    assert a.rank_of("A", "conv-y") == _NO_AFFINITY


def test_forget_sandbox_drops_only_that_sandbox():
    a = Affinity()
    a.record("A", "conv-x")
    a.record("A", "conv-y")
    a.forget_sandbox("conv-x")
    assert a.rank_of("A", "conv-x") == _NO_AFFINITY
    assert a.rank_of("A", "conv-y") == 0
