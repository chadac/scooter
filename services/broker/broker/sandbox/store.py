"""Sandbox size store — the per-conversation pod size spec, broker-owned.

The size a conversation's sandbox is provisioned at (cpu/memory/gpu) is declarative
state the broker owns: written by `set_sandbox_resources` (agent tool) and
`scooter-rebuild limits` (in-pod), applied by the broker at spawn/resume. Kubelet
can't resize a running pod, so a size change takes effect on the next pod start.

Backed by the SHARED Postgres (`broker` DB), SQLAlchemy async — mirrors aws/store.py.
The spec is stored as JSON text (the friendly {requests, limits} shape), portable
across SQLite (dev) + Postgres.
"""

from __future__ import annotations

import json

from sqlalchemy import String, Text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .resources import SandboxResources
from ..aws.store import StoreConfig  # reuse the shared-DB DSN assembly


class _Base(DeclarativeBase):
    pass


class _SizeRow(_Base):
    __tablename__ = "sandbox_size"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    # The friendly {requests?, limits?} shape as JSON (portable SQLite/Postgres).
    spec_json: Mapped[str] = mapped_column(Text, default="{}")
    updated_at: Mapped[str] = mapped_column(String, default="")


class SandboxSizeStore:
    """Persists the per-conversation size spec. Async (asyncpg/aiosqlite)."""

    def __init__(self, config: StoreConfig) -> None:
        self._engine: AsyncEngine = create_async_engine(config.resolved_dsn(), echo=False)
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)

    async def init(self) -> None:
        async with self._engine.begin() as conn:
            await conn.run_sync(_Base.metadata.create_all)

    async def get(self, conversation_id: str) -> SandboxResources | None:
        async with self._session() as s:
            row = await s.get(_SizeRow, conversation_id)
            if row is None:
                return None
            try:
                return SandboxResources.from_dict(json.loads(row.spec_json))
            except (ValueError, TypeError):
                # A corrupt row must NOT silently fall back to a default size — but
                # neither should it break a spawn. Return None (caller uses the
                # deployment/platform default) and log-worthy at the call site.
                return None

    async def set(self, conversation_id: str, spec: SandboxResources, now_iso: str = "") -> None:
        payload = json.dumps(spec.to_dict())
        async with self._session() as s, s.begin():
            row = await s.get(_SizeRow, conversation_id)
            if row is None:
                s.add(_SizeRow(conversation_id=conversation_id, spec_json=payload, updated_at=now_iso))
            else:
                row.spec_json = payload
                row.updated_at = now_iso
