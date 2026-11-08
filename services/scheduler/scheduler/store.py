"""Async SQLAlchemy store for scheduled tasks and runs."""

from __future__ import annotations

import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from .cron import next_run, validate
from .models import Base, RunConversationRow, RunRow, TaskRow, new_id

# The id prefix of a system task's row, so it can never collide with a user task's uuid.
SYSTEM_PREFIX = "system:"
# Serialises the system-task sync across replicas (pg_advisory_xact_lock).
_SYNC_LOCK_KEY = 0x5C4ED7A5


@dataclass(frozen=True)
class SystemTaskSpec:
    """One entry of system-tasks.json, as modules/scheduler.nix renders it."""

    id: str
    command: str
    args: list[str]
    cron: str | None
    timezone: str
    interval_seconds: int | None
    timeout_seconds: int
    model: str | None
    # Why this image cannot run it, else None (see systasks.load).
    unavailable: str | None = None


def _aware(dt: datetime) -> datetime:
    """SQLite hands back naive UTC datetimes."""
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def next_fire(row: TaskRow, after: datetime) -> datetime:
    """When a task is next due after `after`: its interval, else its cron."""
    if row.interval_seconds:
        return _aware(after) + timedelta(seconds=row.interval_seconds)
    return next_run(row.cron, row.timezone, after)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Store:
    def __init__(self, dsn: str):
        # pool_pre_ping recycles a connection the server closed underneath the pool, and
        # pool_recycle retires connections before common idle-timeout windows.
        # Bounded so every replica fits under the shared Postgres's max_connections.
        sizing = {"pool_size": 2, "max_overflow": 4} if dsn.startswith("postgresql") else {}
        self._engine = create_async_engine(
            dsn,
            future=True,
            pool_pre_ping=True,
            pool_recycle=1800,
            **sizing,
        )
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)

    async def dispose(self) -> None:
        await self._engine.dispose()

    # --- tasks --------------------------------------------------------------

    async def create_task(
        self, *, title: str, prompt: str, cron: str, timezone_: str, owner: str, enabled: bool,
        conversation_id: str | None = None,
    ) -> TaskRow:
        """Persist a task, validating cron and timezone (InvalidSchedule) and computing the first next_run_at."""
        validate(cron, timezone_)
        now = _utcnow()
        row = TaskRow(
            id=new_id(), title=title, prompt=prompt, cron=cron, timezone=timezone_,
            owner=owner, enabled=enabled,
            conversation_id=conversation_id or None,
            next_run_at=next_run(cron, timezone_, now) if enabled else None,
        )
        async with self._session() as s:
            s.add(row)
            await s.commit()
            await s.refresh(row)
        return row

    # Every read and write below filters on `owner`, where None is the anonymous "" bucket,
    # a real scope rather than a wildcard.

    @staticmethod
    def _owner_eq(owner: str | None):
        """The owner predicate, mapping anonymous (None) to the "" bucket."""
        return TaskRow.owner == (owner or "")

    # The /tasks routes see user tasks only: system tasks are owned by config.
    _USER = TaskRow.kind == "user"

    @staticmethod
    def _is_users(row: TaskRow | None, owner: str | None) -> bool:
        return row is not None and row.kind == "user" and row.owner == (owner or "")

    async def list_tasks(self, owner: str | None) -> list[TaskRow]:
        async with self._session() as s:
            q = select(TaskRow).where(self._owner_eq(owner), self._USER).order_by(TaskRow.created_at.desc())
            return list((await s.scalars(q)).all())

    async def get_task(self, task_id: str, owner: str | None) -> TaskRow | None:
        async with self._session() as s:
            row = await s.get(TaskRow, task_id)
            # Another owner's task is reported as absent, since a 403 would confirm the id exists.
            return row if self._is_users(row, owner) else None

    async def patch_task(self, task_id: str, owner: str | None, **fields) -> TaskRow | None:
        """Update the given fields and recompute next_run_at, returning None for another owner's task."""
        async with self._session() as s:
            row = await s.get(TaskRow, task_id)
            if not self._is_users(row, owner):
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

    async def disable_task(self, task_id: str) -> None:
        """Stop a task firing, e.g. once its target conversation is gone."""
        async with self._session() as s:
            await s.execute(
                update(TaskRow).where(TaskRow.id == task_id).values(
                    enabled=False, next_run_at=None, updated_at=_utcnow()
                )
            )
            await s.commit()

    async def delete_task(self, task_id: str, owner: str | None) -> bool:
        async with self._session() as s:
            row = await s.get(TaskRow, task_id)
            if not self._is_users(row, owner):
                return False
            await s.delete(row)
            await s.commit()
            return True

    # --- scheduler loop -----------------------------------------------------

    async def due_tasks(self, now: datetime) -> list[TaskRow]:
        """Enabled tasks whose next_run_at is due, as a read-only selection that does not claim."""
        stmt = select(TaskRow).where(
            TaskRow.enabled.is_(True), TaskRow.next_run_at.is_not(None), TaskRow.next_run_at <= now
        )
        async with self._session() as s:
            return list((await s.scalars(stmt)).all())

    async def gauge_counts(self, now: datetime) -> tuple[int, int, int]:
        """(enabled, disabled, due_backlog) across all owners for the observable gauges, to be read before claim_due advances next_run_at."""
        enabled_count = func.count().filter(TaskRow.enabled.is_(True))
        disabled_count = func.count().filter(TaskRow.enabled.is_(False))
        backlog_count = func.count().filter(
            TaskRow.enabled.is_(True),
            TaskRow.next_run_at.is_not(None),
            TaskRow.next_run_at <= now,
        )
        async with self._session() as s:
            stmt = select(enabled_count, disabled_count, backlog_count).select_from(TaskRow)
            row = (await s.execute(stmt)).one()
        return int(row[0]), int(row[1]), int(row[2])

    async def claim_due(self, now: datetime) -> list[TaskRow]:
        """Atomically claim all due tasks by selecting them FOR UPDATE SKIP LOCKED and advancing next_run_at before releasing the lock, so a second replica skips them; returns the claimed rows."""
        stmt = (
            select(TaskRow)
            .where(
                TaskRow.enabled.is_(True), TaskRow.unavailable.is_(None),
                TaskRow.next_run_at.is_not(None), TaskRow.next_run_at <= now,
            )
            .with_for_update(skip_locked=True)
        )
        async with self._session() as s:
            rows = list((await s.scalars(stmt)).all())
            for row in rows:
                # The claim lag rides along as a transient attribute for metrics; SQLite returns naive-UTC datetimes.
                if row.next_run_at:
                    next_run_aware = row.next_run_at if row.next_run_at.tzinfo else row.next_run_at.replace(tzinfo=timezone.utc)
                    row._claim_lag_ms = (now - next_run_aware).total_seconds() * 1000  # type: ignore
                # next_run is computed from `now` so a missed window fires once, with no backfill storm.
                row.last_run_at = now
                row.next_run_at = next_fire(row, now)
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
        """Runs for a task the caller owns, scoped by joining the parent task."""
        async with self._session() as s:
            stmt = (
                select(RunRow)
                .join(TaskRow, TaskRow.id == RunRow.task_id)
                .where(RunRow.task_id == task_id, self._owner_eq(owner), self._USER)
                .order_by(RunRow.fired_at.desc())
                .limit(limit)
            )
            return list((await s.scalars(stmt)).all())

    async def prune_old_runs(self, *, retention_days: int, now: datetime) -> int:
        """Delete task_runs older than retention_days (0 disables the sweep) and return the count deleted."""
        if retention_days == 0:
            return 0
        
        cutoff = now - timedelta(days=retention_days)
        async with self._session() as s:
            result = await s.execute(delete(RunRow).where(RunRow.fired_at < cutoff))
            await s.commit()
            return result.rowcount

    # --- system tasks -------------------------------------------------------

    async def sync_system_tasks(self, specs: list[SystemTaskSpec], now: datetime | None = None) -> None:
        """Make the system rows match `specs`: upsert each, delete the rest (their runs cascade).

        Runs under an advisory lock so two replicas starting together cannot race it. A row
        whose schedule did not change keeps its next_run_at; a new or rescheduled one is due
        at once (interval) or at its next cron time."""
        now = now or _utcnow()
        wanted = {SYSTEM_PREFIX + s.id: s for s in specs}
        async with self._session() as s:
            if self._engine.dialect.name == "postgresql":
                await s.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": _SYNC_LOCK_KEY})
            existing = {
                r.id: r for r in (await s.scalars(select(TaskRow).where(TaskRow.kind == "system"))).all()
            }
            for row_id in existing.keys() - wanted.keys():
                await s.delete(existing[row_id])
            for row_id, spec in wanted.items():
                row = existing.get(row_id)
                if row is None:
                    row = TaskRow(id=row_id, kind="system", owner="", enabled=True, created_at=now)
                    s.add(row)
                reschedule = (
                    row.next_run_at is None
                    or row.cron != spec.cron
                    or row.timezone != spec.timezone
                    or row.interval_seconds != spec.interval_seconds
                )
                row.title = spec.id
                row.prompt = ""
                row.command = spec.command
                row.args = json.dumps(spec.args)
                row.cron = spec.cron
                row.timezone = spec.timezone
                row.interval_seconds = spec.interval_seconds
                row.timeout_seconds = spec.timeout_seconds
                row.model = spec.model
                row.unavailable = spec.unavailable
                row.updated_at = now
                if reschedule:
                    row.next_run_at = now if spec.interval_seconds else next_run(spec.cron, spec.timezone, now)
            await s.commit()

    async def list_system_tasks(self) -> list[TaskRow]:
        async with self._session() as s:
            q = select(TaskRow).where(TaskRow.kind == "system").order_by(TaskRow.id)
            return list((await s.scalars(q)).all())

    async def start_system_run(self, task: TaskRow, token: str, now: datetime | None = None) -> str | None:
        """Open a `running` run for a system task, or return None while another run of it is live.

        A run left `running` past its timeout plus a minute (its replica died mid-run) is closed
        as failed first, so a crash cannot wedge the task forever."""
        now = now or _utcnow()
        stale_before = now - timedelta(seconds=(task.timeout_seconds or 0) + 60)
        async with self._session() as s:
            live = (await s.scalars(
                select(RunRow).where(RunRow.task_id == task.id, RunRow.status == "running").with_for_update()
            )).all()
            for run in live:
                if _aware(run.fired_at) < stale_before:
                    run.status, run.error = "failed", "the scheduler stopped during this run"
                    run.finished_at, run.report_token_sha256 = now, None
                else:
                    await s.commit()
                    return None
            run_id = new_id()
            s.add(RunRow(id=run_id, task_id=task.id, status="running", fired_at=now,
                         report_token_sha256=token_hash(token)))
            await s.commit()
        return run_id

    async def finish_system_run(
        self, run_id: str, *, status: str, exit_code: int | None, error: str | None
    ) -> None:
        async with self._session() as s:
            await s.execute(
                update(RunRow).where(RunRow.id == run_id).values(
                    status=status, exit_code=exit_code, error=error,
                    finished_at=_utcnow(), report_token_sha256=None,
                )
            )
            await s.commit()

    async def record_run_conversation(
        self, run_id: str, token: str, *, conversation_id: str, owner: str | None
    ) -> bool:
        """Record a spawn on a live run whose secret is `token`; False if no such run is running."""
        async with self._session() as s:
            run = await s.get(RunRow, run_id)
            if run is None or run.status != "running" or run.report_token_sha256 is None:
                return False
            if not hmac.compare_digest(run.report_token_sha256, token_hash(token)):
                return False
            if await s.get(RunConversationRow, (run_id, conversation_id)) is None:
                s.add(RunConversationRow(run_id=run_id, conversation_id=conversation_id, owner=owner))
            await s.commit()
            return True

    async def list_run_conversations(self, run_id: str) -> list[RunConversationRow]:
        async with self._session() as s:
            q = select(RunConversationRow).where(RunConversationRow.run_id == run_id)
            return list((await s.scalars(q)).all())

    async def list_system_runs(self, task_id: str, limit: int = 50) -> list[RunRow]:
        async with self._session() as s:
            q = select(RunRow).where(RunRow.task_id == task_id).order_by(RunRow.fired_at.desc()).limit(limit)
            return list((await s.scalars(q)).all())
