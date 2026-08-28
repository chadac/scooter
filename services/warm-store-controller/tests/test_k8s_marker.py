"""Tier 1 — the imperative marker read (ControllerK8s.read_unmount_marker + _job_result),
against a monkeypatched `_apis()`. These lock the producer-side half of the wedge fix:

  - a TERMINATING claimed PVC spawns NO marker-check Job (that Job can never schedule — the
    claim is being deleted — so it would time out and be misread as unclean → another delete);
  - a read failure / timeout resolves to "unknown", NEVER "unclean" (a failure to READ is not
    evidence the volume is dirty; the loop backs off instead of destroying a good volume).
"""

from types import SimpleNamespace
from unittest.mock import MagicMock

from kubernetes import client

import warm_store_controller.k8s as k8smod
from warm_store_controller.k8s import ControllerK8s, _job_result


def _pvc(name: str, *, terminating: bool = False):
    meta = SimpleNamespace(
        name=name,
        deletion_timestamp="2026-08-28T00:00:00Z" if terminating else None,
        labels={"scooter.io/pool-state": "claimed", "scooter.io/claimed-by": "conv-a"},
    )
    return SimpleNamespace(metadata=meta)


def _fake_apis(monkeypatch, *, claimed_items, batch=None):
    core = MagicMock()
    core.list_namespaced_persistent_volume_claim.return_value.items = claimed_items
    batch = batch or MagicMock()
    monkeypatch.setattr(k8smod, "_apis", lambda: (core, MagicMock(), batch, MagicMock()))
    return core, batch


def test_terminating_claim_spawns_no_marker_job(monkeypatch):
    core, batch = _fake_apis(monkeypatch, claimed_items=[_pvc("warm-store-x", terminating=True)])
    k = ControllerK8s(namespace="ns")
    assert k.read_unmount_marker("conv-a") == "unknown"
    batch.create_namespaced_job.assert_not_called()  # the doomed Job is never created


def test_missing_claim_is_unknown_no_job(monkeypatch):
    core, batch = _fake_apis(monkeypatch, claimed_items=[])
    k = ControllerK8s(namespace="ns")
    assert k.read_unmount_marker("conv-a") == "unknown"
    batch.create_namespaced_job.assert_not_called()


def test_marker_read_api_error_is_unknown_not_unclean(monkeypatch):
    batch = MagicMock()
    batch.create_namespaced_job.side_effect = client.ApiException(status=500, reason="boom")
    _fake_apis(monkeypatch, claimed_items=[_pvc("warm-store-x")], batch=batch)
    k = ControllerK8s(namespace="ns")
    # A read that ERRORS must not be reported as unclean (which the loop maps to delete).
    assert k.read_unmount_marker("conv-a") == "unknown"


def test_healthy_claim_reads_the_marker_clean(monkeypatch):
    # A non-terminating claim DOES spawn the check Job; a Completed Job → "clean".
    batch = MagicMock()
    created = SimpleNamespace(metadata=SimpleNamespace(name="warm-marker-check-abc"))
    batch.create_namespaced_job.return_value = created
    batch.read_namespaced_job_status.return_value = SimpleNamespace(
        status=SimpleNamespace(succeeded=1, failed=0)
    )
    _fake_apis(monkeypatch, claimed_items=[_pvc("warm-store-x")], batch=batch)
    k = ControllerK8s(namespace="ns")
    assert k.read_unmount_marker("conv-a") == "clean"
    batch.create_namespaced_job.assert_called_once()


def test_definitively_failed_check_is_unclean(monkeypatch):
    # The Job ran and the marker file was absent (Failed) → unclean (a genuine dirty overlay).
    batch = MagicMock()
    batch.create_namespaced_job.return_value = SimpleNamespace(
        metadata=SimpleNamespace(name="warm-marker-check-abc")
    )
    batch.read_namespaced_job_status.return_value = SimpleNamespace(
        status=SimpleNamespace(succeeded=0, failed=1)
    )
    _fake_apis(monkeypatch, claimed_items=[_pvc("warm-store-x")], batch=batch)
    k = ControllerK8s(namespace="ns")
    assert k.read_unmount_marker("conv-a") == "unclean"


class _Clock:
    """A fake monotonic clock so the timeout path doesn't sleep in real time."""

    def __init__(self):
        self._t = 0.0

    def time(self):
        return self._t

    def sleep(self, s):
        self._t += s


def test_job_result_timeout_is_unknown_not_failed(monkeypatch):
    # A check Job that never reaches a terminal state within the deadline is UNKNOWN, not
    # "failed" — the caller maps failed→unclean→delete, so a timeout must not do that.
    batch = MagicMock()
    batch.read_namespaced_job_status.return_value = SimpleNamespace(
        status=SimpleNamespace(succeeded=0, failed=0)  # never terminal
    )
    monkeypatch.setattr(k8smod, "_apis", lambda: (MagicMock(), MagicMock(), batch, MagicMock()))
    assert _job_result("warm-marker-check-abc", "ns", timeout_s=5.0, clock=_Clock()) == "unknown"
