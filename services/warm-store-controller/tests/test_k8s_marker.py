"""Reading a marker-check Job: only the command's own failure means dirty."""

from warm_store_controller.k8s import marker_status


def job(succeeded=0, failed=0, reason=None):
    conds = [{"type": "Failed", "reason": reason}] if reason else []
    return {"status": {"succeeded": succeeded, "failed": failed, "conditions": conds}}


def test_marker_status():
    assert marker_status(job(succeeded=1)) == "clean"
    assert marker_status(job(failed=1, reason="BackoffLimitExceeded")) == "dirty"
    assert marker_status(job(failed=1, reason="DeadlineExceeded")) == "unknown"
    assert marker_status(job()) == "running"
    assert marker_status({"status": None}) == "running"


def _check(tmp_path, marker: str | None, storage: str = "20Gi") -> int:
    import subprocess

    from warm_store_controller.k8s import CLEAN_MARKER_PATH, ControllerK8s

    path = tmp_path / "clean-shutdown"
    path.unlink(missing_ok=True)
    if marker is not None:
        path.write_text(marker)
    script = ControllerK8s(namespace="ns", overlay_storage=storage).marker_check_script()
    return subprocess.run(["sh", "-c", script.replace(CLEAN_MARKER_PATH, str(path))]).returncode


def test_marker_check_wipes_an_upper_over_the_pvc_size(tmp_path):
    gib = 1024**3
    assert _check(tmp_path, f'{{"tag":"t","stoppedAt":"x","upperBytes":{8 * gib}}}\n') == 0
    assert _check(tmp_path, f'{{"tag":"t","stoppedAt":"x","upperBytes":{31 * gib}}}\n') != 0
    # Markers from images without GC carry no size and stay clean.
    assert _check(tmp_path, '{"tag":"t","stoppedAt":"x"}\n') == 0
    assert _check(tmp_path, None) != 0
