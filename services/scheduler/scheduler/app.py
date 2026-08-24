"""Scheduler service — a REST API for scheduled tasks + a background loop that fires
due tasks by spawning a fresh Scooter conversation (agent-host /agui) per run."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Header, HTTPException

from .config import require_relay_key, settings
from .cron import InvalidSchedule
from .metrics import MetricsSink, create_metrics
from .models import Run, Task, TaskCreate, TaskPatch
from .spawn import spawn_conversation
from .store import Store

# Configure the root logger so our logger.info/debug actually reach stdout — without
# this the root defaults to WARNING and everything below it is silently dropped (only
# uvicorn's own logger prints). Level from LOG_LEVEL (settings.log_level), default INFO.
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

logger = logging.getLogger("scheduler")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def _fire(store: Store, task, metrics: MetricsSink) -> None:
    """Spawn one run for an ALREADY-CLAIMED task and record it. The task's
    next_run_at was advanced atomically by claim_due (the double-fire guard), so
    _fire must NOT reschedule — it only spawns + records the run."""
    start_ms = time.perf_counter() * 1000
    run_id = await store.start_run(task.id)
    conv = await spawn_conversation(task.prompt, title=task.title, owner=task.owner)
    await store.finish_run(
        run_id,
        conversation_id=conv,
        status="spawned" if conv else "failed",
        error=None if conv else "spawn returned no conversation",
    )
    duration_ms = (time.perf_counter() * 1000) - start_ms
    metrics.fire_completed(status="spawned" if conv else "failed", duration_ms=duration_ms)
    logger.info("fired task %s (%s) -> conversation %s", task.id, task.title, conv)


async def _scheduler_loop(store: Store, metrics: MetricsSink, stop: asyncio.Event) -> None:
    """Every tick, fire all due tasks. A missed window (service down) fires once on
    recovery (next_run_at is in the past) then advances forward — no backfill storm."""
    tick_count = 0
    while not stop.is_set():
        outcome = "ok"
        try:
            now = _utcnow()
            # claim_due ATOMICALLY claims + advances next_run_at, so with 2+ replicas
            # each due task is fired by exactly one replica (no double-fire). If a
            # spawn then fails, next_run_at has already advanced — the run is recorded
            # 'failed' and we don't retry until the next cron window (at-most-once).
            due = await store.claim_due(now)
            
            for task in due:
                try:
                    await _fire(store, task, metrics)
                except Exception:  # one bad task must not stall the loop
                    logger.exception("failed firing task %s", task.id)
                    outcome = "error"
            
            # Run retention sweep roughly hourly (not every tick — tick is 30s by default).
            # Check every ~120 ticks = 3600s = 1 hour (at default tick_seconds=30).
            tick_count += 1
            if settings.run_retention_days > 0 and tick_count % 120 == 0:
                try:
                    deleted = await store.prune_old_runs(retention_days=settings.run_retention_days, now=now)
                    if deleted > 0:
                        metrics.runs_pruned(count=deleted)
                        logger.info("pruned %d old runs (retention=%d days)", deleted, settings.run_retention_days)
                except Exception:
                    logger.exception("retention sweep failed")
                    outcome = "error"
        except Exception:
            logger.exception("scheduler tick failed")
            outcome = "error"
        
        # CRITICAL: increment scheduler_ticks_total EVERY tick, even if no tasks were due.
        # This is the dead-loop detector — its absence means the tick loop is stuck.
        metrics.tick_completed(outcome=outcome)
        
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=settings.tick_seconds)


@asynccontextmanager
async def lifespan(app: FastAPI):
    store = Store(settings.dsn)
    await store.init()
    app.state.store = store
    
    # Initialize metrics (no-op if disabled)
    metrics = create_metrics(enabled=settings.otel_metrics_enabled)
    app.state.metrics = metrics
    
    stop = asyncio.Event()
    loop = asyncio.create_task(_scheduler_loop(store, metrics, stop))
    try:
        yield
    finally:
        stop.set()
        loop.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await loop
        await metrics.shutdown()
        await store.dispose()


app = FastAPI(title="agent-scheduler", version="0.1.0", lifespan=lifespan)


# The task owner IS the request identity — a user can't create tasks owned by
# someone else. The ingress sets x-auth-user (the identity the agent-host trusts);
# the agent-host forwards it, sending an EMPTY x-auth-user for the anonymous /
# unowned scope (a deployment with no ingress auth, like a personal cluster). That
# is a VALID scope, not an error: an absent/empty header maps to the unowned bucket
# ("" owner), matching the agent-host's Owner contract (null owner -> ""). We never
# 401 here — the trust boundary is the ingress + the relay key, not this header.
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
        )
    except InvalidSchedule as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return Task.of(row)


@app.get("/tasks", response_model=list[Task], dependencies=[Depends(require_relay_key)])
async def list_tasks() -> list[Task]:
    return [Task.of(r) for r in await app.state.store.list_tasks()]


@app.get("/tasks/{task_id}", response_model=Task, dependencies=[Depends(require_relay_key)])
async def get_task(task_id: str) -> Task:
    row = await app.state.store.get_task(task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return Task.of(row)


@app.patch("/tasks/{task_id}", response_model=Task, dependencies=[Depends(require_relay_key)])
async def patch_task(task_id: str, body: TaskPatch) -> Task:
    try:
        row = await app.state.store.patch_task(
            task_id, title=body.title, prompt=body.prompt, cron=body.cron,
            timezone=body.timezone, enabled=body.enabled,
        )
    except InvalidSchedule as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    return Task.of(row)


@app.delete("/tasks/{task_id}", status_code=204, dependencies=[Depends(require_relay_key)])
async def delete_task(task_id: str) -> None:
    if not await app.state.store.delete_task(task_id):
        raise HTTPException(status_code=404, detail="task not found")


@app.get("/tasks/{task_id}/runs", response_model=list[Run], dependencies=[Depends(require_relay_key)])
async def list_runs(task_id: str) -> list[Run]:
    return [Run.of(r) for r in await app.state.store.list_runs(task_id)]


@app.post("/tasks/{task_id}/run", response_model=Run, dependencies=[Depends(require_relay_key)])
async def run_now(task_id: str) -> Run:
    """Fire a task immediately (ad-hoc; also the smoke test). Does NOT change the
    cron schedule's next_run_at beyond the normal advance."""
    row = await app.state.store.get_task(task_id)
    if row is None:
        raise HTTPException(status_code=404, detail="task not found")
    await _fire(app.state.store, row, app.state.metrics)
    runs = await app.state.store.list_runs(task_id, limit=1)
    return Run.of(runs[0])


def main() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080)
