"""Workspace grants, in this contrib's own `contrib_databricks` database.

The DDL lives in contrib/databricks/sql/schema.sql (Atlas owns it); this module never creates tables.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from sqlalchemy import BigInteger, String, select, update
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

READ, WRITE = "read", "read-write"


class _Base(DeclarativeBase):
    pass


class _Grant(_Base):
    __tablename__ = "databricks_grants"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(String, index=True)
    workspace: Mapped[str] = mapped_column(String)
    level: Mapped[str] = mapped_column(String)
    approved_by: Mapped[str] = mapped_column(String)
    # The approval that created it, or its first ancestor's.
    request_id: Mapped[str] = mapped_column(String)
    created_at: Mapped[int] = mapped_column(BigInteger)
    # NULL: until revoked.
    expires_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    revoked_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    revoked_by: Mapped[str | None] = mapped_column(String, nullable=True)
    parent_id: Mapped[str | None] = mapped_column(String, nullable=True)


@dataclass(frozen=True)
class Grant:
    id: str
    conversation_id: str
    workspace: str
    level: str
    approved_by: str
    request_id: str
    created_at: int
    expires_at: int | None
    revoked_at: int | None = None
    revoked_by: str | None = None
    parent_id: str | None = None

    def active(self, now: int | None = None) -> bool:
        if self.revoked_at is not None:
            return False
        return self.expires_at is None or self.expires_at > (now if now is not None else now_ms())

    def covers(self, level: str) -> bool:
        return self.level == WRITE or level == READ


def now_ms() -> int:
    return int(time.time() * 1000)


def _grant(row: _Grant) -> Grant:
    return Grant(id=row.id, conversation_id=row.conversation_id, workspace=row.workspace, level=row.level,
                 approved_by=row.approved_by, request_id=row.request_id, created_at=row.created_at,
                 expires_at=row.expires_at, revoked_at=row.revoked_at, revoked_by=row.revoked_by,
                 parent_id=row.parent_id)


def _live(now: int) -> tuple:
    return (_Grant.revoked_at.is_(None), _Grant.expires_at.is_(None) | (_Grant.expires_at > now))


class GrantStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine, self._session = open_sessions(config)

    async def add(self, conversation_id: str, workspace: str, level: str, *, minutes: int,
                  approved_by: str, request_id: str, parent_id: str | None = None) -> Grant:
        now = now_ms()
        row = _Grant(id=str(uuid.uuid4()), conversation_id=conversation_id, workspace=workspace, level=level,
                     approved_by=approved_by, request_id=request_id, created_at=now,
                     expires_at=now + minutes * 60_000, parent_id=parent_id)
        async with self._session() as s, s.begin():
            s.add(row)
        return _grant(row)

    async def get(self, grant_id: str) -> Grant | None:
        async with self._session() as s:
            row = await s.get(_Grant, grant_id)
        return _grant(row) if row else None

    async def allows(self, conversation_id: str, workspace: str, level: str) -> bool:
        q = select(_Grant).where(_Grant.conversation_id == conversation_id, _Grant.workspace == workspace,
                                 *_live(now_ms()))
        async with self._session() as s:
            return any(_grant(r).covers(level) for r in (await s.scalars(q)).all())

    async def all(self, conversation_id: str) -> list[Grant]:
        """Every grant the conversation ever had, newest first."""
        q = select(_Grant).where(_Grant.conversation_id == conversation_id).order_by(_Grant.created_at.desc())
        async with self._session() as s:
            return [_grant(r) for r in (await s.scalars(q)).all()]

    async def _end(self, where: tuple, **values) -> int:
        async with self._session() as s, s.begin():
            done = await s.execute(update(_Grant).where(*where, *_live(now_ms())).values(**values)
                                   .execution_options(synchronize_session=False))
        return done.rowcount

    async def set_expiry(self, grant_id: str, expires_at: int | None) -> Grant | None:
        """Move a live grant's end; None if it is no longer live."""
        n = await self._end((_Grant.id == grant_id,), expires_at=expires_at)
        return await self.get(grant_id) if n == 1 else None

    async def revoke(self, grant_id: str, by: str) -> Grant | None:
        """End a live grant now; None if it already ended."""
        n = await self._end((_Grant.id == grant_id,), revoked_at=now_ms(), revoked_by=by)
        return await self.get(grant_id) if n == 1 else None

    async def revoke_conversation(self, conversation_id: str, by: str) -> int:
        return await self._end((_Grant.conversation_id == conversation_id,), revoked_at=now_ms(), revoked_by=by)
