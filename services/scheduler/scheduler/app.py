"""Scheduler service: a REST API for scheduled tasks plus a background loop that fires due tasks.

A due user task spawns a fresh conversation or prompts its target one; a due system
task (scooter.systemTasks) runs as a subprocess through systasks.Runner.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.exc import DataError, DBAPIError, IntegrityError, ProgrammingError

from .config import require_relay_key, settings
from .cron import InvalidSchedule
from .logging_config import configure_logging, get_logger
from .metrics import MetricsSink, create_metrics
from .models import Run, RunConversation, Task, TaskCreate, TaskPatch
from .spawn import SpawnResult, deliver, spawn
from .store import Store
from .systasks import Runner, load as load_system_tasks

configure_logging("scheduler", default_level=settings.log_level)

logger = get_logger("app")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def _fire(store: Store, task, metrics: MetricsSink) -> None:
    """Spawn one run for an already-claimed task and record it, without rescheduling since claim_due already advanced next_run_at; a run that cannot spawn is recorded as failed, never skipped silently."""
    start_ms = time.perf_counter() * 1000

    if hasattr(task, "_claim_lag_ms"):
        metrics.claim_lag(lag_ms=task._claim_lag_ms)

    run_id: str | None = None
    result = SpawnResult(None, "spawn did not run")
    try:
        run_id = await store.start_run(task.id)
        if task.conversation_id:
            result = await deliver(task.conversation_id, task.prompt, owner=task.owner)
        else:
            result = await spawn(task.prompt, title=task.title, owner=task.owner)
    except Exception as e:  # noqa: BLE001 — the claim already consumed this window
        result = SpawnResult(None, f"spawn errored: {type(e).__name__}: {e}")
        logger.exception("spawn errored", extra={"task_id": task.id})
    if not result.conversation_id:
        status = "failed"
    else:
        status = "delivered" if task.conversation_id else "spawned"
    await _record_run(store, task.id, run_id, result, status)
    if result.gone:
        # Its conversation was deleted, so further firings can only fail.
        try:
            await store.disable_task(task.id)
            logger.warning("disabled task: target conversation gone", extra={"task_id": task.id})
        except Exception:  # noqa: BLE001
            logger.exception("could not disable task", extra={"task_id": task.id})

    duration_ms = (time.perf_counter() * 1000) - start_ms
    metrics.fire_completed(status=status, duration_ms=duration_ms)
    logger.info(
        "fired task",
        extra={
            "task_id": task.id,
            "task_title": task.title,
            "conversation_id": result.conversation_id,
            "status": status,
            "error": result.error,
            "duration_ms": duration_ms,
        },
    )


async def _record_run(store: Store, task_id: str, run_id: str | None, result: SpawnResult, status: str) -> None:
    """Finish the run row (creating it if start_run never landed), retrying once across a DB blip."""
    for attempt in (1, 2):
        try:
            if run_id is None:
                run_id = await store.start_run(task_id)
            await store.finish_run(
                run_id, conversation_id=result.conversation_id, status=status, error=result.error
            )
            return
        except Exception:  # noqa: BLE001
            if attempt == 2:
                logger.exception(
                    "could not record the run; it is missing from task history",
                    extra={"task_id": task_id, "run_status": status, "error": result.error},
                )
                return
            await asyncio.sleep(1.0)


async def _scheduler_loop(store: Store, metrics: MetricsSink, stop: asyncio.Event, runner: Runner | None = None) -> None:
    """Every tick, fire all due tasks; a missed window fires once on recovery, with no backfill storm."""
    tick_count = 0
    while not stop.is_set():
        outcome = "ok"
        try:
            now = _utcnow()
            # The gauges are fed before claiming, since claim_due zeroes the backlog, and a
            # gauge failure must never fail the tick.
            try:
                enabled, disabled, backlog = await store.gauge_counts(now)
                metrics.set_task_counts(enabled=enabled, disabled=disabled)
                metrics.set_due_backlog(count=backlog)
            except Exception:
                logger.warning("gauge refresh failed — task gauges will report their last value", exc_info=True)

            # Each due task is fired by exactly one replica, at most once per cron window.
            due = await store.claim_due(now)
            
            for task in due:
                try:
                    if task.kind == "system":
                        # In the background, so a long run never delays the tick.
                        if runner is not None:
                            runner.launch(task)
                        continue
                    await _fire(store, task, metrics)
                except Exception:  # one bad task must not stall the loop
                    logger.exception("failed firing task", extra={"task_id": task.id})
                    outcome = "error"
            
            # The retention sweep runs every 120 ticks, roughly hourly at the default tick.
            tick_count += 1
            if settings.run_retention_days > 0 and tick_count % 120 == 0:
                try:
                    deleted = await store.prune_old_runs(retention_days=settings.run_retention_days, now=now)
                    if deleted > 0:
                        metrics.runs_pruned(count=deleted)
                        logger.info(
                            "pruned old runs",
                            extra={
                                "deleted_count": deleted,
                                "retention_days": settings.run_retention_days,
                            },
                        )
                except Exception:
                    logger.exception("retention sweep failed")
                    outcome = "error"
        except Exception:
            logger.exception("scheduler tick failed")
            outcome = "error"
        
        # Counted every tick, even with no due tasks, since this is the dead-loop detector.
        metrics.tick_completed(outcome=outcome)
        
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=settings.tick_seconds)


# Outlasts a postgres or pgbouncer restart during startup.
STARTUP_DB_BUDGET_S = 60.0


async def sync_with_retry(store: Store, specs, *, budget_s: float = STARTUP_DB_BUDGET_S, sleep=asyncio.sleep) -> None:
    """Sync the system tasks, retrying an unreachable database with capped backoff until `budget_s` runs out."""
    deadline = time.monotonic() + budget_s
    delay = 0.5
    attempt = 0
    while True:
        attempt += 1
        try:
            await store.sync_system_tasks(specs)
            return
        except (OSError, DBAPIError) as err:
            # Query and schema faults won't fix themselves.
            if isinstance(err, (DataError, IntegrityError, ProgrammingError)) or time.monotonic() + delay > deadline:
                raise
            logger.warning(
                "database not reachable at startup; retrying",
                extra={"attempt": attempt, "retry_in_s": delay, "error": repr(err)},
            )
            await sleep(delay)
            delay = min(delay * 2, 8.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    store = Store(settings.dsn)
    app.state.store = store
    
    metrics = create_metrics(enabled=settings.otel_metrics_enabled)
    app.state.metrics = metrics
    
    # A list that does not parse fails startup; a task whose command is missing is skipped.
    await sync_with_retry(store, load_system_tasks(settings.system_tasks_path))
    runner = Runner(
        store, metrics,
        concurrency=settings.system_task_concurrency,
        kill_grace_seconds=settings.system_task_kill_grace_seconds,
    )
    app.state.runner = runner

    stop = asyncio.Event()
    loop = asyncio.create_task(_scheduler_loop(store, metrics, stop, runner))
    try:
        yield
    finally:
        stop.set()
        loop.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await loop
        await runner.shutdown()
        await metrics.shutdown()
        await store.dispose()


app = FastAPI(title="agent-scheduler", version="0.1.0", lifespan=lifespan)


# The task owner is the forwarded x-auth-user identity, where an absent or empty header is
# the valid anonymous "" scope rather than an error.
def _owner(x_auth_user: str | None = Header(default=None)) -> str:
    return x_auth_user or ""


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.post("/tasks", response_model=Task, dependencies=[Depends(require_relay_key)])
async def create_task(body: TaskCreate, owner: str = Depends(_owner)) -> Task:
    try:
        row = await app.state.store.create_task(
            title=body.title, prompt=body.prompt, cron=body.cron,
            timezone_=body.timezone, owner=owner, enabled=body.enabled,
            conversation_id=body.conversation_id,
        )
    except InvalidSchedule as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return Task.of(row)


# Every route below scopes to `owner`, reporting another owner's task as 404 rather than 403.
@app.get("/tasks", response_model=list[Task], dependencies=[Depends(require_relay_key)])
async def list_tasks(owner: str = Depends(_owner)) -> list[Task]:
    return [Task.of(r) for r in await app.state.store.list_tasks(owner)]


@app.get("/tasks/{task_id}", response_model=Task, dependencies=[Depends(require_relay_key)])
async def get_task(task_id: str, owner: str = Depends(_owner)) -> Task:
    row = await app.state.store.get_task(task_id, owner)
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return Task.of(row)


@app.patch("/tasks/{task_id}", response_model=Task, dependencies=[Depends(require_relay_key)])
async def patch_task(task_id: str, body: TaskPatch, owner: str = Depends(_owner)) -> Task:
    # Target is fixed so ownership is checked only at creation.
    if "conversation_id" in body.model_fields_set:
        raise HTTPException(status_code=422, detail="conversation_id cannot be changed; recreate the task")
    try:
        row = await app.state.store.patch_task(
            task_id, owner, title=body.title, prompt=body.prompt, cron=body.cron,
            timezone=body.timezone, enabled=body.enabled,
        )
    except InvalidSchedule as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return Task.of(row)


@app.delete("/tasks/{task_id}", status_code=204, dependencies=[Depends(require_relay_key)])
async def delete_task(task_id: str, owner: str = Depends(_owner)) -> None:
    if not await app.state.store.delete_task(task_id, owner):
        raise HTTPException(status_code=404, detail="task not found")


@app.get("/tasks/{task_id}/runs", response_model=list[Run], dependencies=[Depends(require_relay_key)])
async def list_runs(task_id: str, owner: str = Depends(_owner)) -> list[Run]:
    # Checked first so an unowned id 404s like every other route.
    if await app.state.store.get_task(task_id, owner) is None:
        raise HTTPException(status_code=404, detail="task not found")
    return [Run.of(r) for r in await app.state.store.list_runs(task_id, owner)]


@app.post("/tasks/{task_id}/run", response_model=Run, dependencies=[Depends(require_relay_key)])
async def run_now(task_id: str, owner: str = Depends(_owner)) -> Run:
    """Fire a task immediately, owner-scoped since firing spawns a conversation as the task's owner."""
    row = await app.state.store.get_task(task_id, owner)
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    await _fire(app.state.store, row, app.state.metrics)
    runs = await app.state.store.list_runs(task_id, owner, limit=1)
    return Run.of(runs[0])


_run_token = HTTPBearer(auto_error=False)


# The task contract's spawn report. It is authorised by the run's own secret
# (SCOOTER_TASK_RUN_TOKEN, stored hashed), not the relay key: only the process the
# scheduler started for this run holds it, and only while the run is going.
@app.post("/runs/{run_id}/conversations", status_code=204)
async def record_run_conversation(
    run_id: str,
    body: RunConversation,
    creds: HTTPAuthorizationCredentials | None = Security(_run_token),
) -> None:
    if creds is None or not await app.state.store.record_run_conversation(
        run_id, creds.credentials, conversation_id=body.conversation_id, owner=body.owner
    ):
        # One answer for a wrong token, an unknown run and a finished one.
        raise HTTPException(status_code=403, detail="not a running system-task run, or the wrong run token")


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
