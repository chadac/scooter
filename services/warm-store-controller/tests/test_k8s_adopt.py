"""Tier 1 — ControllerK8s.adopt_bound_pvs against a monkeypatched `_apis()`.

Locks the fix for the pool that never warmed: adoption is a SWEEP over every warm-store
PVC, decoupled from the pending set. A dynamically-provisioned PV inherits none of its
PVC's labels and binds (WaitForFirstConsumer) only after a pod mounts the claim — i.e.
AFTER the sandbox leaves list_pending_uppers. Keying adoption off `pending` (the old bug)
meant the PV was never bound on any pass adoption looked at it, so it stayed unlabelled and
invisible to iter_pool_pvs forever → zero placements, zero recycles. See PR #403.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

from kubernetes import client

import warm_store_controller.k8s as k8smod
from warm_store_controller.k8s import ControllerK8s, LBL_WARM_STORE


def _pvc(name, *, volume_name, tag="abc123"):
    labels = {LBL_WARM_STORE: tag} if tag is not None else {}
    return SimpleNamespace(
        metadata=SimpleNamespace(name=name, labels=labels),
        spec=SimpleNamespace(volume_name=volume_name),
    )


def _pv(name, *, labels=None):
    return SimpleNamespace(metadata=SimpleNamespace(name=name, labels=labels or {}))


def _fake_apis(monkeypatch, *, pvcs, pvs):
    core = MagicMock()
    core.list_namespaced_persistent_volume_claim.return_value.items = pvcs
    core.read_persistent_volume.side_effect = lambda n: pvs[n]
    monkeypatch.setattr(k8smod, "_apis", lambda: (core, MagicMock(), MagicMock(), MagicMock()))
    return core


def test_bound_unlabelled_pv_is_labelled_into_the_pool(monkeypatch):
    core = _fake_apis(
        monkeypatch,
        pvcs=[_pvc("scooter-rw-conv-a", volume_name="pv-1", tag="abc123")],
        pvs={"pv-1": _pv("pv-1", labels={})},
    )
    ControllerK8s(namespace="ns").adopt_bound_pvs()
    core.patch_persistent_volume.assert_called_once_with(
        "pv-1", {"metadata": {"labels": {LBL_WARM_STORE: "abc123"}}}
    )


def test_sweep_selects_by_warm_store_label_not_the_pending_set(monkeypatch):
    # The heart of the fix: the candidate set is EVERY warm-store PVC, discovered here —
    # never a caller-supplied `pending` list. A bound PVC gets adopted even though no
    # sandbox is pending (the PV bound long after its sandbox left the pending window).
    core = _fake_apis(
        monkeypatch,
        pvcs=[_pvc("scooter-rw-conv-a", volume_name="pv-1", tag="abc123")],
        pvs={"pv-1": _pv("pv-1", labels={})},
    )
    ControllerK8s(namespace="ns").adopt_bound_pvs()
    _, kwargs = core.list_namespaced_persistent_volume_claim.call_args
    assert kwargs.get("label_selector") == LBL_WARM_STORE
    core.patch_persistent_volume.assert_called_once()


def test_unbound_pvc_is_skipped(monkeypatch):
    # WaitForFirstConsumer: no PV yet, nothing to label. Must not read/patch a PV.
    core = _fake_apis(
        monkeypatch,
        pvcs=[_pvc("scooter-rw-conv-a", volume_name=None, tag="abc123")],
        pvs={},
    )
    ControllerK8s(namespace="ns").adopt_bound_pvs()
    core.read_persistent_volume.assert_not_called()
    core.patch_persistent_volume.assert_not_called()


def test_already_labelled_pv_is_not_re_patched(monkeypatch):
    # Idempotent — a PV already carrying the tag is left alone (no churn every pass).
    core = _fake_apis(
        monkeypatch,
        pvcs=[_pvc("scooter-rw-conv-a", volume_name="pv-1", tag="abc123")],
        pvs={"pv-1": _pv("pv-1", labels={LBL_WARM_STORE: "abc123"})},
    )
    ControllerK8s(namespace="ns").adopt_bound_pvs()
    core.patch_persistent_volume.assert_not_called()


def test_a_vanished_pvc_404_does_not_abort_the_sweep(monkeypatch):
    # One PVC's PV read 404s (raced deletion); the other must still be adopted.
    core = _fake_apis(
        monkeypatch,
        pvcs=[
            _pvc("gone", volume_name="pv-gone", tag="abc123"),
            _pvc("live", volume_name="pv-live", tag="abc123"),
        ],
        pvs={"pv-live": _pv("pv-live", labels={})},
    )

    def read(n):
        if n == "pv-gone":
            raise client.ApiException(status=404, reason="Not Found")
        return _pv("pv-live", labels={})

    core.read_persistent_volume.side_effect = read
    ControllerK8s(namespace="ns").adopt_bound_pvs()
    core.patch_persistent_volume.assert_called_once_with(
        "pv-live", {"metadata": {"labels": {LBL_WARM_STORE: "abc123"}}}
    )
