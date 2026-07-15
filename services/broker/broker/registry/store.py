"""Module registry store — the broker-side catalog of shareable modules.

A module = metadata (owner/name/description/visibility/version) + its Nix files (a
JSON blob {filename: contents}). Backed by the shared broker Postgres (SQLAlchemy
async), mirroring broker/sandbox/store.py + broker/aws/store.py. Authoritative: a
failed create/publish PROPAGATES (the user expects their module to persist).

Visibility ('private' | 'public') gates the CATALOG listing (own private + all
public); the download path serves files for any id (Nix isn't a secret).
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

from sqlalchemy import String, Text, select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from ..aws.store import StoreConfig  # reuse the shared-DB DSN assembly


@dataclass
class Module:
    """A registry module (metadata + files)."""

    id: str
    owner: str
    name: str
    description: str
    visibility: str  # 'private' | 'public'
    version: int
    files: dict[str, str] = field(default_factory=dict)  # {filename: contents}
    created_at: str = ""
    updated_at: str = ""

    def summary(self) -> dict:
        """Metadata WITHOUT the file blob — for list/catalog responses."""
        return {
            "id": self.id,
            "owner": self.owner,
            "name": self.name,
            "description": self.description,
            "visibility": self.visibility,
            "version": self.version,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class _Base(DeclarativeBase):
    pass


class _ModuleRow(_Base):
    __tablename__ = "module_registry"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    owner: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str] = mapped_column(String, index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    visibility: Mapped[str] = mapped_column(String, default="private", index=True)
    version: Mapped[int] = mapped_column(default=1)
    files_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[str] = mapped_column(String, default="")
    updated_at: Mapped[str] = mapped_column(String, default="")


def _to_module(row: _ModuleRow) -> Module:
    return Module(
        id=row.id,
        owner=row.owner,
        name=row.name,
        description=row.description or "",
        visibility=row.visibility,
        version=row.version,
        files=json.loads(row.files_json or "{}"),
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


class ModuleRegistryStore:
    """Persists registry modules. Async (asyncpg/aiosqlite)."""

    def __init__(self, config: StoreConfig) -> None:
        self._engine: AsyncEngine = create_async_engine(config.resolved_dsn(), echo=False)
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)

    async def init(self) -> None:
        async with self._engine.begin() as conn:
            await conn.run_sync(_Base.metadata.create_all)

    async def get(self, module_id: str) -> Module | None:
        async with self._session() as s:
            row = await s.get(_ModuleRow, module_id)
            return _to_module(row) if row else None

    async def get_files(self, module_id: str) -> dict[str, str] | None:
        """The files blob for the download path. None if the module doesn't exist."""
        m = await self.get(module_id)
        return m.files if m else None

    async def list_visible(self, viewer: str, query: str = "") -> list[Module]:
        """Modules VISIBLE to `viewer`: their own (any visibility) + all public.
        Optional case-insensitive substring `query` over name + description."""
        async with self._session() as s:
            stmt = select(_ModuleRow).where(
                (_ModuleRow.owner == viewer) | (_ModuleRow.visibility == "public")
            )
            rows = list((await s.execute(stmt)).scalars())
        mods = [_to_module(r) for r in rows]
        if query:
            q = query.lower()
            mods = [m for m in mods if q in m.name.lower() or q in m.description.lower()]
        mods.sort(key=lambda m: m.updated_at, reverse=True)
        return mods

    async def upsert(
        self,
        *,
        module_id: str,
        owner: str,
        name: str,
        description: str,
        visibility: str,
        files: dict[str, str],
        now_iso: str = "",
    ) -> Module:
        """Create a module, or re-publish an existing one (bumping version). The owner
        is stamped by the caller (the resolved identity) — never a request field. A
        re-publish by a DIFFERENT owner is rejected (ownership is immutable)."""
        payload = json.dumps(files)
        async with self._session() as s, s.begin():
            row = await s.get(_ModuleRow, module_id)
            if row is None:
                row = _ModuleRow(
                    id=module_id, owner=owner, name=name, description=description,
                    visibility=visibility, version=1, files_json=payload,
                    created_at=now_iso, updated_at=now_iso,
                )
                s.add(row)
            else:
                if row.owner != owner:
                    raise PermissionError(f"module {module_id} is owned by another user")
                row.name = name
                row.description = description
                row.visibility = visibility
                row.files_json = payload
                row.version += 1
                row.updated_at = now_iso
            await s.flush()
            return _to_module(row)
