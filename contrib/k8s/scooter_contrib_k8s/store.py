"""Write grants, in this contrib's own `contrib_k8s` database.

The DDL lives in contrib/k8s/sql/schema.sql (Atlas owns it); this module never creates tables.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass

from sqlalchemy import BigInteger, String, select
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
    approved_by: Mapped[str] = mapped_column(String)
    # The approval that created it.
    request_id: Mapped[str] = mapped_column(String)
    created_at: Mapped[int] = mapped_column(BigInteger)
    expires_at: Mapped[int] = mapped_column(BigInteger)


@dataclass(frozen=True)
class Grant:
    id: str
    conversation_id: str
    cluster: str
    namespace: str
    approved_by: str
    request_id: str
    expires_at: int


def _now_ms() -> int:
    return int(time.time() * 1000)


def _grant(row: _Grant) -> Grant:
    return Grant(id=row.id, conversation_id=row.conversation_id, cluster=row.cluster, namespace=row.namespace,
                 approved_by=row.approved_by, request_id=row.request_id, expires_at=row.expires_at)


class GrantStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine, self._session = open_sessions(config)

    async def add(self, conversation_id: str, cluster: str, namespace: str, *, minutes: int,
                  approved_by: str, request_id: str) -> Grant:
        now = _now_ms()
        row = _Grant(id=str(uuid.uuid4()), conversation_id=conversation_id, cluster=cluster, namespace=namespace,
                     approved_by=approved_by, request_id=request_id, created_at=now,
                     expires_at=now + minutes * 60_000)
        async with self._session() as s, s.begin():
            s.add(row)
        return _grant(row)

    async def active(self, conversation_id: str, cluster: str | None = None,
                     namespace: str | None = None) -> list[Grant]:
        """Unexpired grants for a conversation, soonest to expire first."""
        q = select(_Grant).where(_Grant.conversation_id == conversation_id, _Grant.expires_at > _now_ms())
        if cluster is not None:
            q = q.where(_Grant.cluster == cluster)
        if namespace is not None:
            q = q.where(_Grant.namespace == namespace)
        async with self._session() as s:
            return [_grant(r) for r in (await s.scalars(q.order_by(_Grant.expires_at))).all()]
