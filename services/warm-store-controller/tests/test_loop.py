"""Tier 1 — the reconcile LOOP against a fake k8s (in-memory PVCs + Sandboxes). No cluster.
Locks that the loop lists → reconciles → applies each action to the ControllerK8s."""

from warm_store_controller.loop import reconcile_once
from warm_store_controller.reservations import Reservations
from warm_store_controller.reconcile import PoolPvc, SandboxRef, PoolConfig

TAG = "abc123def456"
OLD = "000oldtag0000"


class FakeK8s:
    """In-memory pool PVCs + Sandboxes. Records every applied action for assertions.
    warm_new/relabel/delete_pvc mutate the in-memory PVC set so a follow-up pass sees them."""

    def __init__(self, pvcs, sandboxes):
        self._pvcs = {p.name: p for p in pvcs}
        self._sandboxes = list(sandboxes)
        self.warmed = []      # [image_tag]
        self.relabels = []    # [(pvc, state, labels)]
        self.deletes = []     # [pvc]
        self._warm_seq = 0

    def list_pool_pvcs(self):
        return list(self._pvcs.values())

    # The PV layer is not what these tests cover; an empty pool makes it a no-op.
    def list_pending_uppers(self):
        return []

    def iter_pool_pvs(self):
        return iter(())

    def adopt_bound_pvs(self):
        self.adopt_calls = getattr(self, 'adopt_calls', 0) + 1

    def list_nodes(self):
        return []

    def list_sandboxes(self):
        return list(self._sandboxes)

    def warm_new(self, image_tag):
        self.warmed.append(image_tag)
        self._warm_seq += 1
        name = f"warm-{image_tag}-{self._warm_seq}"
        self._pvcs[name] = PoolPvc(name=name, image_tag=image_tag, state="warming")

    def relabel(self, pvc, state, labels):
        self.relabels.append((pvc, state, labels))
        cur = self._pvcs[pvc]
        self._pvcs[pvc] = PoolPvc(
            name=cur.name,
            image_tag=cur.image_tag,
            state=state,
            claimed_by=(None if labels.get("scooter.io/claimed-by", "keep") is None else cur.claimed_by),
            last_used=cur.last_used,
            bound_to_pod=cur.bound_to_pod,
        )

    def delete_pvc(self, pvc):
        self.deletes.append(pvc)
        self._pvcs.pop(pvc, None)


def cfg(min_ready=1, max_total=8):
    return PoolConfig(current_image_tag=TAG, min_ready=min_ready, max_total=max_total)


def test_loop_warms_when_pool_empty():
    k = FakeK8s([], [])
    reconcile_once(k, cfg(min_ready=2), Reservations(), {})
    assert k.warmed == [TAG, TAG]


def test_loop_returns_suspended_clean_pvc():
    k = FakeK8s(
        [PoolPvc("p1", TAG, "claimed", claimed_by="conv-a", bound_to_pod=False)],
        [SandboxRef("conv-a", TAG, suspended=True, unmount_marker="clean")],
    )
    reconcile_once(k, cfg(min_ready=1), Reservations(), {})
    assert ("p1", "ready", {"scooter.io/claimed-by": None}) in k.relabels


def test_loop_discards_unclean_return():
    k = FakeK8s(
        [PoolPvc("p1", TAG, "claimed", claimed_by="conv-a", bound_to_pod=False)],
        [SandboxRef("conv-a", TAG, suspended=True, unmount_marker="unclean")],
    )
    reconcile_once(k, cfg(min_ready=0), Reservations(), {})
    assert "p1" in k.deletes


def test_loop_does_not_redelete_terminating_pvc():
    # The whole loop, end to end: a claimed PVC that is already Terminating, with an `unclean`
    # sandbox, must NOT be deleted again (the spin that pinned pool volumes in Terminating).
    k = FakeK8s(
        [PoolPvc("p1", TAG, "claimed", claimed_by="conv-a", bound_to_pod=False, terminating=True)],
        [SandboxRef("conv-a", TAG, suspended=True, unmount_marker="unclean")],
    )
    reconcile_once(k, cfg(min_ready=0), Reservations(), {})
    assert "p1" not in k.deletes


def test_loop_unknown_marker_does_not_delete():
    # A suspended sandbox whose marker read was inconclusive → the loop backs off, no delete.
    k = FakeK8s(
        [PoolPvc("p1", TAG, "claimed", claimed_by="conv-a", bound_to_pod=False)],
        [SandboxRef("conv-a", TAG, suspended=True, unmount_marker="unknown")],
    )
    reconcile_once(k, cfg(min_ready=0), Reservations(), {})
    assert k.deletes == []


def test_loop_gcs_retired_tag():
    k = FakeK8s([PoolPvc("r-old", OLD, "ready")], [])
    reconcile_once(k, cfg(min_ready=0), Reservations(), {})
    assert "r-old" in k.deletes


def test_loop_one_bad_action_does_not_abort_pass():
    # A delete that raises must not stop a subsequent warm from applying.
    class Boom(FakeK8s):
        def delete_pvc(self, pvc):
            raise RuntimeError("boom")

    k = Boom([PoolPvc("r-old", OLD, "ready")], [])
    # retired-tag delete raises; the pass still completes (min_ready top-up still runs).
    reconcile_once(k, cfg(min_ready=1), Reservations(), {})
    assert k.warmed == [TAG]  # top-up applied despite the delete failure
