"""Write and Secret grants, in this contrib's own `contrib_k8s` database.

The DDL lives in contrib/k8s/sql/schema.sql (Atlas owns it); this module never creates tables.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from sqlalchemy import BigInteger, String, select, update
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions


class _Base(DeclarativeBase):
    pass


class _Grant(_Base):
    __tablename__ = "k8s_grants"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(String, index=True)
    cluster: Mapped[str] = mapped_column(String)
    namespace: Mapped[str] = mapped_column(String)
    # "write", or "secret" for reading the Secrets in `names`.
    kind: Mapped[str] = mapped_column(String, default="write")
    # Comma-separated Secret names; empty for a write grant.
    names: Mapped[str] = mapped_column(String, default="")
    approved_by: Mapped[str] = mapped_column(String)
    # The approval that created it, or its first ancestor's.
    request_id: Mapped[str] = mapped_column(String)
    created_at: Mapped[int] = mapped_column(BigInteger)
    # NULL: until revoked.
    expires_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    revoked_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    revoked_by: Mapped[str | None] = mapped_column(String, nullable=True)
    # The grant this one revived.
    parent_id: Mapped[str | None] = mapped_column(String, nullable=True)


@dataclass(frozen=True)
class Grant:
    id: str
    conversation_id: str
    cluster: str
    namespace: str
    approved_by: str
    request_id: str
    expires_at: int | None
    kind: str = "write"
    names: tuple[str, ...] = ()
    created_at: int = 0
    revoked_at: int | None = None
    revoked_by: str | None = None
    parent_id: str | None = None

    def active(self, now: int | None = None) -> bool:
        if self.revoked_at is not None:
            return False
        return self.expires_at is None or self.expires_at > (now if now is not None else _now_ms())


def _now_ms() -> int:
    return int(time.time() * 1000)


def _grant(row: _Grant) -> Grant:
    return Grant(id=row.id, conversation_id=row.conversation_id, cluster=row.cluster, namespace=row.namespace,
                 approved_by=row.approved_by, request_id=row.request_id, expires_at=row.expires_at,
                 kind=row.kind, names=tuple(n for n in row.names.split(",") if n), created_at=row.created_at,
                 revoked_at=row.revoked_at, revoked_by=row.revoked_by, parent_id=row.parent_id)


def _live(now: int) -> tuple:
    return (_Grant.revoked_at.is_(None), _Grant.expires_at.is_(None) | (_Grant.expires_at > now))


class GrantStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine, self._session = open_sessions(config)

    async def add(self, conversation_id: str, cluster: str, namespace: str, *, minutes: int,
                  approved_by: str, request_id: str, kind: str = "write", names: tuple[str, ...] = (),
                  parent_id: str | None = None) -> Grant:
        now = _now_ms()
        row = _Grant(id=str(uuid.uuid4()), conversation_id=conversation_id, cluster=cluster, namespace=namespace,
                     kind=kind, names=",".join(names), approved_by=approved_by, request_id=request_id, created_at=now,
                     expires_at=now + minutes * 60_000, parent_id=parent_id)
        async with self._session() as s, s.begin():
            s.add(row)
        return _grant(row)

    async def get(self, grant_id: str) -> Grant | None:
        async with self._session() as s:
            row = await s.get(_Grant, grant_id)
        return _grant(row) if row else None

    async def active(self, conversation_id: str, cluster: str | None = None,
                     namespace: str | None = None, *, kind: str | None = None) -> list[Grant]:
        """Live grants for a conversation, soonest to expire first; `kind` None means both."""
        q = select(_Grant).where(_Grant.conversation_id == conversation_id, *_live(_now_ms()))
        if cluster is not None:
            q = q.where(_Grant.cluster == cluster)
        if namespace is not None:
            q = q.where(_Grant.namespace == namespace)
        if kind is not None:
            q = q.where(_Grant.kind == kind)
        async with self._session() as s:
            rows = (await s.scalars(q.order_by(_Grant.expires_at.asc().nulls_last()))).all()
        return [_grant(r) for r in rows]

    async def all(self, conversation_id: str) -> list[Grant]:
        """Every grant the conversation ever had, newest first."""
        q = select(_Grant).where(_Grant.conversation_id == conversation_id).order_by(_Grant.created_at.desc())
        async with self._session() as s:
            return [_grant(r) for r in (await s.scalars(q)).all()]

    async def set_expiry(self, grant_id: str, expires_at: int | None) -> Grant | None:
        """Move a live grant's end; None if it is no longer live."""
        async with self._session() as s, s.begin():
            done = await s.execute(
                update(_Grant).where(_Grant.id == grant_id, *_live(_now_ms()))
                .values(expires_at=expires_at).execution_options(synchronize_session=False)
            )
        return await self.get(grant_id) if done.rowcount == 1 else None

    async def revoke(self, grant_id: str, by: str) -> Grant | None:
        """End a live grant now; None if it already ended."""
        async with self._session() as s, s.begin():
            done = await s.execute(
                update(_Grant).where(_Grant.id == grant_id, *_live(_now_ms()))
                .values(revoked_at=_now_ms(), revoked_by=by).execution_options(synchronize_session=False)
            )
        return await self.get(grant_id) if done.rowcount == 1 else None

    async def revoke_conversation(self, conversation_id: str, by: str) -> int:
        async with self._session() as s, s.begin():
            done = await s.execute(
                update(_Grant).where(_Grant.conversation_id == conversation_id, *_live(_now_ms()))
                .values(revoked_at=_now_ms(), revoked_by=by).execution_options(synchronize_session=False)
            )
        return done.rowcount
