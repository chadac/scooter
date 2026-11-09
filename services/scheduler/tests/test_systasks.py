"""System tasks: the task list, the sync into scheduled_tasks, and runs under the task contract."""

from __future__ import annotations

import asyncio
import json
import os
import stat
from datetime import datetime, timedelta, timezone

import httpx
import pytest

import scheduler.app as appmod
from scheduler import systasks
from scheduler.config import settings
from scheduler.metrics import create_metrics
from scheduler.models import RunRow, TaskRow
from scheduler.store import SystemTaskSpec
from scheduler.systasks import InvalidTaskList, Runner, load

from conftest import file_store

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=timezone.utc)


def _spec(id="t", command="/bin/true", **kw) -> SystemTaskSpec:
    base = dict(id=id, command=command, args=[], cron=None, timezone="UTC",
                interval_seconds=3600, timeout_seconds=60, model="fast-model")
    return SystemTaskSpec(**{**base, **kw})


def _script(tmp_path, name: str, body: str) -> str:
    p = tmp_path / name
    p.write_text("#!/bin/sh\n" + body)
    p.chmod(p.stat().st_mode | stat.S_IXUSR)
    return str(p)


@pytest.fixture(autouse=True)
def _tmp_dirs(tmp_path, monkeypatch):
    work = tmp_path / "work"
    work.mkdir()
    monkeypatch.setattr(settings, "task_tmp_dir", str(work))
    monkeypatch.setattr(settings, "scheduler_url", "http://scheduler")


# --- load ---------------------------------------------------------------------

def test_a_missing_task_list_means_no_system_tasks(tmp_path):
    assert load(str(tmp_path / "absent.json")) == []


def test_load_marks_a_command_missing_from_the_image_unavailable(tmp_path):
    ok = _script(tmp_path, "ok", "exit 0\n")
    noexec = tmp_path / "noexec"
    noexec.write_text("")
    f = tmp_path / "tasks.json"
    f.write_text(json.dumps([
        {"id": "ok", "command": ok, "args": ["--x"], "cron": None, "timezone": "UTC",
         "interval_seconds": 60, "timeout_seconds": 10, "model": "m"},
        {"id": "gone", "command": "/nix/store/nope/bin/x", "interval_seconds": 60, "timeout_seconds": 10},
        {"id": "noexec", "command": str(noexec), "cron": "0 * * * *", "timeout_seconds": 10},
    ]))
    by_id = {s.id: s for s in load(str(f))}
    assert by_id["ok"].unavailable is None and by_id["ok"].args == ["--x"]
    assert "does not exist" in by_id["gone"].unavailable
    assert "not executable" in by_id["noexec"].unavailable


@pytest.mark.parametrize("entry", [
    {"id": "both", "command": "/bin/true", "cron": "* * * * *", "interval_seconds": 60, "timeout_seconds": 1},
    {"id": "neither", "command": "/bin/true", "timeout_seconds": 1},
    {"id": "no-timeout", "command": "/bin/true", "interval_seconds": 60},
])
def test_a_malformed_task_list_refuses_startup(tmp_path, entry):
    f = tmp_path / "tasks.json"
    f.write_text(json.dumps([entry]))
    with pytest.raises(InvalidTaskList):
        load(str(f))


# --- sync ---------------------------------------------------------------------

async def test_sync_upserts_and_deletes_with_runs_cascading(tmp_path):
    store = await file_store(tmp_path)
    await store.sync_system_tasks([_spec("a"), _spec("b", cron="0 9 * * *", interval_seconds=None)], now=NOW)
    rows = {r.id: r for r in await store.list_system_tasks()}
    assert set(rows) == {"system:a", "system:b"}
    assert rows["system:a"].kind == "system" and rows["system:a"].owner == ""
    # An interval task is due at once; a cron one at its next time.
    assert rows["system:a"].next_run_at.replace(tzinfo=timezone.utc) == NOW
    assert rows["system:b"].next_run_at.replace(tzinfo=timezone.utc) == NOW.replace(day=2, hour=9)

    run_id = await store.start_system_run(rows["system:b"], "tok", now=NOW)
    await store.sync_system_tasks([_spec("a", args=["--new"])], now=NOW + timedelta(minutes=5))
    rows = {r.id: r for r in await store.list_system_tasks()}
    assert set(rows) == {"system:a"}
    assert json.loads(rows["system:a"].args) == ["--new"]
    async with store._session() as s:
        assert await s.get(RunRow, run_id) is None
    await store.dispose()


async def test_sync_keeps_next_run_unless_the_schedule_changed(tmp_path):
    store = await file_store(tmp_path)
    await store.sync_system_tasks([_spec("a")], now=NOW)
    (row,) = await store.claim_due(NOW)
    assert row.next_run_at == NOW + timedelta(hours=1)  # interval scheduling

    later = NOW + timedelta(minutes=10)
    await store.sync_system_tasks([_spec("a", timeout_seconds=5)], now=later)
    (row,) = await store.list_system_tasks()
    assert row.next_run_at.replace(tzinfo=timezone.utc) == NOW + timedelta(hours=1)

    await store.sync_system_tasks([_spec("a", interval_seconds=60)], now=later)
    (row,) = await store.list_system_tasks()
    assert row.next_run_at.replace(tzinfo=timezone.utc) == later
    await store.dispose()


async def test_an_unavailable_task_is_never_claimed(tmp_path):
    store = await file_store(tmp_path)
    await store.sync_system_tasks([_spec("a", unavailable="missing")], now=NOW)
    assert await store.claim_due(NOW + timedelta(days=1)) == []
    await store.dispose()


async def test_the_tasks_routes_never_show_system_rows(tmp_path):
    store = await file_store(tmp_path)
    await store.sync_system_tasks([_spec("a")], now=NOW)
    appmod.app.state.store = store
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=appmod.app), base_url="http://t") as c:
        # System rows have owner "", the anonymous bucket, so anonymous is the case to check.
        assert (await c.get("/tasks")).json() == []
        assert (await c.get("/tasks/system:a")).status_code == 404
        assert (await c.patch("/tasks/system:a", json={"enabled": False})).status_code == 404
        assert (await c.delete("/tasks/system:a")).status_code == 404
        assert (await c.get("/tasks/system:a/runs")).status_code == 404
        assert (await c.post("/tasks/system:a/run")).status_code == 404
    assert len(await store.list_system_tasks()) == 1
    await store.dispose()


# --- runs ---------------------------------------------------------------------

async def _setup(tmp_path, *specs, concurrency=4, grace=30.0):
    store = await file_store(tmp_path)
    await store.sync_system_tasks(list(specs), now=NOW)
    rows = {r.id.removeprefix("system:"): r for r in await store.list_system_tasks()}
    return store, Runner(store, create_metrics(enabled=False), concurrency=concurrency, kill_grace_seconds=grace), rows


async def _only_run(store, task_id):
    (run,) = await store.list_system_runs("system:" + task_id)
    return run


async def _appears(path):
    """Wait until a run's script creates `path`, so it is live."""
    async def poll():
        while not path.exists():
            await asyncio.sleep(0.01)
    await asyncio.wait_for(poll(), 10)


async def test_a_run_gets_the_contract_env_and_nothing_else(tmp_path, monkeypatch):
    monkeypatch.setenv("DB_PASSWORD", "hunter2")
    out = tmp_path / "env.txt"
    cmd = _script(tmp_path, "envdump", f'env > {out}\npwd >> {out}\necho "$@" >> {out}\n')
    store, runner, rows = await _setup(tmp_path, _spec("dump", command=cmd, args=["--a", "b c"]))
    assert runner.launch(rows["dump"])
    await runner.wait_idle()

    run = await _only_run(store, "dump")
    assert (run.status, run.exit_code, run.error) == ("succeeded", 0, None)
    assert run.finished_at is not None and run.report_token_sha256 is None
    lines = out.read_text().splitlines()
    env = dict(l.split("=", 1) for l in lines if "=" in l)
    assert env["SCOOTER_TASK_ID"] == "dump"
    assert env["SCOOTER_TASK_RUN_ID"] == run.id
    assert env["SCOOTER_TASK_MODEL"] == "fast-model"
    assert env["SCHEDULER_URL"] == "http://scheduler"
    assert env["SCOOTER_TASK_RUN_TOKEN"]
    datetime.fromisoformat(env["SCOOTER_TASK_DEADLINE"])
    assert "DB_PASSWORD" not in env and "hunter2" not in out.read_text()
    assert lines[-2].endswith(f"/task-{run.id}") and lines[-1] == "--a b c"
    # The working directory is removed afterwards.
    assert not os.path.exists(lines[-2])
    await store.dispose()


async def test_a_nonzero_exit_fails_with_the_end_of_stderr(tmp_path):
    cmd = _script(tmp_path, "boom", "yes noise | head -c 10000 >&2\necho >&2\necho 'boom: Broken: the reason' >&2\nexit 3\n")
    store, runner, rows = await _setup(tmp_path, _spec("boom", command=cmd))
    runner.launch(rows["boom"])
    await runner.wait_idle()
    run = await _only_run(store, "boom")
    assert (run.status, run.exit_code) == ("failed", 3)
    assert run.error.endswith("boom: Broken: the reason")
    assert len(run.error.encode()) <= systasks.STDERR_TAIL_BYTES
    await store.dispose()


async def test_a_run_past_its_timeout_is_terminated_and_timed_out(tmp_path):
    marker = tmp_path / "got-term"
    cmd = _script(tmp_path, "slow", f"trap 'echo term > {marker}; exit 143' TERM\nsleep 30 & wait\n")
    store, runner, rows = await _setup(tmp_path, _spec("slow", command=cmd, timeout_seconds=1))
    runner.launch(rows["slow"])
    await asyncio.wait_for(runner.wait_idle(), 10)
    run = await _only_run(store, "slow")
    assert run.status == "timed_out" and run.exit_code == 143
    assert marker.read_text().strip() == "term"
    await store.dispose()


async def test_a_run_that_ignores_sigterm_is_killed(tmp_path):
    cmd = _script(tmp_path, "stubborn", "trap '' TERM\nwhile :; do sleep 0.1; done\n")
    store, runner, rows = await _setup(tmp_path, _spec("stubborn", command=cmd, timeout_seconds=1), grace=0.5)
    runner.launch(rows["stubborn"])
    await asyncio.wait_for(runner.wait_idle(), 10)
    run = await _only_run(store, "stubborn")
    assert run.status == "timed_out" and run.exit_code == -9
    await store.dispose()


async def test_one_run_per_task_at_a_time(tmp_path):
    cmd = _script(tmp_path, "nap", "sleep 1\n")
    store, runner, rows = await _setup(tmp_path, _spec("nap", command=cmd))
    assert runner.launch(rows["nap"])
    assert not runner.launch(rows["nap"])
    await runner.wait_idle()
    assert len(await store.list_system_runs("system:nap")) == 1
    await store.dispose()


async def test_a_run_live_on_another_replica_blocks_a_second(tmp_path):
    cmd = _script(tmp_path, "nap", "exit 0\n")
    store, runner, rows = await _setup(tmp_path, _spec("nap", command=cmd))
    other = await store.start_system_run(rows["nap"], "other-replica")
    runner.launch(rows["nap"])
    await runner.wait_idle()
    assert [r.id for r in await store.list_system_runs("system:nap")] == [other]
    await store.dispose()


async def test_a_run_abandoned_by_a_dead_replica_does_not_wedge_the_task(tmp_path):
    cmd = _script(tmp_path, "ok", "exit 0\n")
    store, runner, rows = await _setup(tmp_path, _spec("ok", command=cmd, timeout_seconds=60))
    stale = await store.start_system_run(rows["ok"], "dead", now=datetime.now(timezone.utc) - timedelta(hours=1))
    runner.launch(rows["ok"])
    await runner.wait_idle()
    runs = {r.id: r for r in await store.list_system_runs("system:ok")}
    assert runs.pop(stale).status == "failed"
    assert [r.status for r in runs.values()] == ["succeeded"]
    await store.dispose()


async def test_the_concurrency_cap_holds_across_tasks(tmp_path):
    log = tmp_path / "log"
    body = f"echo start >> {log}\nsleep 0.5\necho end >> {log}\n"
    specs = [_spec(f"t{i}", command=_script(tmp_path, f"t{i}", body)) for i in range(3)]
    store, runner, rows = await _setup(tmp_path, *specs, concurrency=1)
    for r in rows.values():
        runner.launch(r)
    await asyncio.wait_for(runner.wait_idle(), 15)
    assert log.read_text().split() == ["start", "end"] * 3
    await store.dispose()


async def test_shutdown_kills_live_runs_and_records_them_failed(tmp_path):
    started = tmp_path / "started"
    cmd = _script(tmp_path, "forever", f"touch {started}\nsleep 30\n")
    store, runner, rows = await _setup(tmp_path, _spec("forever", command=cmd))
    runner.launch(rows["forever"])
    await _appears(started)
    await asyncio.wait_for(runner.shutdown(), 5)
    run = await _only_run(store, "forever")
    assert run.status == "failed" and "shut down" in run.error
    await store.dispose()


# --- spawn reports --------------------------------------------------------------

async def test_spawn_reports_need_the_live_runs_own_token(tmp_path):
    store, _, rows = await _setup(tmp_path, _spec("fan"), _spec("other"))
    run_id = await store.start_system_run(rows["fan"], "right")
    other_run = await store.start_system_run(rows["other"], "other")
    appmod.app.state.store = store
    body = {"conversation_id": "c1", "owner": "alice"}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=appmod.app), base_url="http://t") as c:
        url = f"/runs/{run_id}/conversations"
        assert (await c.post(url, json=body)).status_code == 403
        assert (await c.post(url, json=body, headers={"authorization": "Bearer wrong"})).status_code == 403
        # Another run's token does not reach this run.
        assert (await c.post(url, json=body, headers={"authorization": "Bearer other"})).status_code == 403
        assert (await c.post(url, json=body, headers={"authorization": "Bearer right"})).status_code == 204
        # Reporting twice is idempotent.
        assert (await c.post(url, json=body, headers={"authorization": "Bearer right"})).status_code == 204
        await store.finish_system_run(run_id, status="succeeded", exit_code=0, error=None)
        late = {"conversation_id": "c2", "owner": "bob"}
        assert (await c.post(url, json=late, headers={"authorization": "Bearer right"})).status_code == 403
    assert [(r.conversation_id, r.owner) for r in await store.list_run_conversations(run_id)] == [("c1", "alice")]
    assert await store.list_run_conversations(other_run) == []
    await store.dispose()


async def test_the_tick_launches_system_tasks_without_waiting_on_them(tmp_path):
    started, release = tmp_path / "started", tmp_path / "release"
    cmd = _script(tmp_path, "nap", f"touch {started}\nwhile [ ! -e {release} ]; do sleep 0.05; done\n")
    store, runner, _ = await _setup(tmp_path, _spec("nap", command=cmd))
    stop = asyncio.Event()

    loop = asyncio.create_task(appmod._scheduler_loop(store, create_metrics(enabled=False), stop, runner))
    await _appears(started)
    stop.set()
    await asyncio.wait_for(loop, 10)  # returns while the run waits for release
    assert (await _only_run(store, "nap")).status == "running"
    release.touch()
    await runner.wait_idle()
    assert (await _only_run(store, "nap")).status == "succeeded"
    await store.dispose()
