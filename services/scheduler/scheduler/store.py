"""Async SQLAlchemy store for scheduled tasks + runs (SQLite dev / Postgres prod)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from .cron import next_run, validate
from .models import Base, RunRow, TaskRow, new_id


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Store:
    def __init__(self, dsn: str):
        # pool_pre_ping: emit a lightweight liveness check when a connection is checked out of the
        # pool and RECYCLE it if the server (or an idle-timeout / proxy / failover) closed it
        # underneath us — instead of handing out a dead connection and failing the request with
        # asyncpg "connection is closed" on the next transaction. pool_recycle caps a connection's
        # lifetime below common idle-timeout windows so stale ones retire proactively. Mirrors the
        # webhooks engine (services/webhooks/webhooks/store.py), which added these after exactly
        # that failure in production; without them a postgres restart / failover breaks this
        # service until it is itself restarted.
        self._engine = create_async_engine(
            dsn,
            future=True,
            pool_pre_ping=True,
            pool_recycle=1800,  # recycle connections older than 30 min
        )
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)

    async def dispose(self) -> None:
        await self._engine.dispose()

    # --- tasks --------------------------------------------------------------

    async def create_task(
        self, *, title: str, prompt: str, cron: str, timezone_: str, owner: str, enabled: bool
    ) -> TaskRow:
        """Persist a task. Validates cron+tz (raises InvalidSchedule → API 422) and
        computes the first next_run_at."""
        validate(cron, timezone_)
        now = _utcnow()
        row = TaskRow(
            id=new_id(), title=title, prompt=prompt, cron=cron, timezone=timezone_,
            owner=owner, enabled=enabled,
            next_run_at=next_run(cron, timezone_, now) if enabled else None,
        )
        async with self._session() as s:
            s.add(row)
            await s.commit()
            await s.refresh(row)
        return row

    # Every read/write below takes `owner` and filters on it. The API layer passes the
    # authenticated identity, so one user can never see or mutate another's task — the
    # scoping the agent-host and MCP tools have always DOCUMENTED but the server did not
    # enforce (it honored x-auth-user on create only). `None` is the unowned/anonymous
    # bucket, a real scope rather than a wildcard, so it must match owner == "" exactly.

    @staticmethod
    def _owner_eq(owner: str | None):
        """The owner predicate. Anonymous (None) maps to the "" bucket write_task uses."""
        return TaskRow.owner == (owner or "")

    async def list_tasks(self, owner: str | None) -> list[TaskRow]:
        async with self._session() as s:
            q = select(TaskRow).where(self._owner_eq(owner)).order_by(TaskRow.created_at.desc())
            return list((await s.scalars(q)).all())

    async def get_task(self, task_id: str, owner: str | None) -> TaskRow | None:
        async with self._session() as s:
            row = await s.get(TaskRow, task_id)
            # Another owner's task is reported as absent, not forbidden — a 403 would
            # confirm the id exists.
            return row if row is not None and row.owner == (owner or "") else None

    async def patch_task(self, task_id: str, owner: str | None, **fields) -> TaskRow | None:
        """Update the given fields. If cron/timezone/enabled change, recompute
        next_run_at (validate first). Another owner's task → None (treated as 404)."""
        async with self._session() as s:
            row = await s.get(TaskRow, task_id)
            if row is None or row.owner != (owner or ""):
                return None
            for k, v in fields.items():
                if v is not None:
                    setattr(row, k, v)
            if row.enabled:
                validate(row.cron, row.timezone)
                row.next_run_at = next_run(row.cron, row.timezone, _utcnow())
            else:
                row.next_run_at = None
            row.updated_at = _utcnow()
            await s.commit()
            await s.refresh(row)
            return row

    async def delete_task(self, task_id: str, owner: str | None) -> bool:
        async with self._session() as s:
            row = await s.get(TaskRow, task_id)
            if row is None or row.owner != (owner or ""):
                return False
            await s.delete(row)
            await s.commit()
            return True

    # --- scheduler loop -----------------------------------------------------

    async def due_tasks(self, now: datetime) -> list[TaskRow]:
        """Enabled tasks whose next_run_at is due (<= now). Read-only selection — does
        NOT claim. Use claim_due() in the scheduler loop; this is for tests/introspection."""
        stmt = select(TaskRow).where(
            TaskRow.enabled.is_(True), TaskRow.next_run_at.is_not(None), TaskRow.next_run_at <= now
        )
        async with self._session() as s:
            return list((await s.scalars(stmt)).all())

    async def claim_due(self, now: datetime) -> list[TaskRow]:
        """ATOMICALLY claim all due tasks: in ONE transaction, select them
        FOR UPDATE SKIP LOCKED and immediately advance each row's next_run_at (+ set
        last_run_at) BEFORE releasing the lock. This is the multi-replica double-fire
        guard: because the reschedule commits inside the locked transaction, a second
        replica's claim_due sees the already-advanced next_run_at and skips the row —
        whereas the old due_tasks() released its lock before _fire rescheduled, leaving
        a window for a second replica to re-select the still-due row and double-fire.

        On Postgres, FOR UPDATE SKIP LOCKED makes two concurrent claim_due calls take
        disjoint rows. On SQLite (single-writer dev) the whole txn is serialized anyway,
        so the same advance-before-release invariant holds. Returns the claimed rows
        (with their PRE-advance schedule) for the loop to fire."""
        stmt = (
            select(TaskRow)
            .where(TaskRow.enabled.is_(True), TaskRow.next_run_at.is_not(None), TaskRow.next_run_at <= now)
            .with_for_update(skip_locked=True)
        )
        async with self._session() as s:
            rows = list((await s.scalars(stmt)).all())
            for row in rows:
                # Store the lag (now - old next_run_at) as a transient attribute for metrics.
                # SQLite returns naive-UTC datetimes; normalize to aware-UTC before subtracting.
                if row.next_run_at:
                    next_run_aware = row.next_run_at if row.next_run_at.tzinfo else row.next_run_at.replace(tzinfo=timezone.utc)
                    row._claim_lag_ms = (now - next_run_aware).total_seconds() * 1000  # type: ignore
                # Advance BEFORE releasing the lock — this is what closes the double-fire
                # window. next_run is computed from `now` (not the stale next_run_at) so a
                # missed window fires once then advances forward (no backfill storm).
                row.last_run_at = now
                row.next_run_at = next_run(row.cron, row.timezone, now)
            await s.commit()
            return rows

    async def reschedule(self, task_id: str, *, last_run_at: datetime, next_run_at: datetime) -> None:
        async with self._session() as s:
            await s.execute(
                update(TaskRow).where(TaskRow.id == task_id).values(last_run_at=last_run_at, next_run_at=next_run_at)
            )
            await s.commit()

    # --- runs ---------------------------------------------------------------

    async def start_run(self, task_id: str) -> str:
        run_id = new_id()
        async with self._session() as s:
            s.add(RunRow(id=run_id, task_id=task_id, status="spawning"))
            await s.commit()
        return run_id

    async def finish_run(self, run_id: str, *, conversation_id: str | None, status: str, error: str | None) -> None:
        async with self._session() as s:
            await s.execute(
                update(RunRow).where(RunRow.id == run_id).values(
                    conversation_id=conversation_id, status=status, error=error
                )
            )
            await s.commit()

    async def list_runs(self, task_id: str, owner: str | None, limit: int = 50) -> list[RunRow]:
        """Runs for a task the caller owns. Scoped by JOINing the parent task rather than
        denormalizing owner onto RunRow, so the task stays the single authority on it."""
        async with self._session() as s:
            stmt = (
                select(RunRow)
                .join(TaskRow, TaskRow.id == RunRow.task_id)
                .where(RunRow.task_id == task_id, self._owner_eq(owner))
                .order_by(RunRow.fired_at.desc())
                .limit(limit)
            )
            return list((await s.scalars(stmt)).all())

    async def prune_old_runs(self, *, retention_days: int, now: datetime) -> int:
        """Delete task_runs older than retention_days. Returns count of deleted rows.
        
        Args:
            retention_days: Delete runs older than this many days. 0 = disabled (no delete).
            now: Current time for computing the cutoff.
        
        Returns:
            Number of rows deleted.
        """
        if retention_days == 0:
            return 0
        
        cutoff = now - timedelta(days=retention_days)
        async with self._session() as s:
            result = await s.execute(delete(RunRow).where(RunRow.fired_at < cutoff))
            await s.commit()
            return result.rowcount
