"""Static-share store — the broker-side persistence for published static bundles.

A *share* is identified by a broker-minted UUID (the URL). It has metadata
(owner/description/visibility/latest_version) plus one or more *versions*, each a
snapshot of the bundle's files. The root URL serves the latest version; updating
a share adds a new version and keeps the UUID. Backed by the shared broker
Postgres (SQLAlchemy async), mirroring broker/registry/store.py.

Schema constraint: the tables (static_shares, static_share_versions) live in
lib/sql/broker/schema.sql and are created by the db-migrator — this store issues
no DDL, only reads/writes rows via the generated scooter_schema.broker models.
Callers use the dataclass API (Share / ShareVersion / ShareFile), never a row.

Two placeholders remain, both behind that API: inline base64 file bytes (intended
backend: object storage) and `owner` = conversation id (no human identity yet, cf.
#127). Rationale on PR #393.
"""

from __future__ import annotations

import base64
import json
import uuid as uuidlib
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker, create_async_engine

# Generated ORM models (lib/sql/broker/schema.sql -> scooter_schema), aliased to this
# store's private row names so the query helpers below read unchanged.
from scooter_schema.broker import (
    StaticShares as _ShareRow,
    StaticShareVersions as _VersionRow,
)

from ..aws.store import StoreConfig  # reuse the shared-DB DSN assembly


@dataclass
class ShareFile:
    """One file in a bundle. `data` is the raw bytes (binary-safe: images, etc.)."""

    path: str
    content_type: str
    data: bytes = b""

    @property
    def size(self) -> int:
        return len(self.data)


@dataclass
class ShareVersion:
    """A single published snapshot of a share's files."""

    version: int
    entry_point: str
    files: dict[str, ShareFile]  # {path: ShareFile}
    created_at: str = ""

    def manifest(self) -> list[dict]:
        """File list WITHOUT bytes — for list/metadata responses."""
        return [
            {"path": f.path, "content_type": f.content_type, "size": f.size}
            for f in self.files.values()
        ]


@dataclass
class Share:
    """A published static share. `uuid` is broker-minted and == the URL."""

    uuid: str
    owner: str
    conversation_id: str
    description: str
    visibility: str  # 'public' | 'private'
    latest_version: int
    created_at: str = ""
    updated_at: str = ""

    def summary(self) -> dict:
        """Metadata WITHOUT any file bytes — for list responses."""
        return {
            "uuid": self.uuid,
            "owner": self.owner,
            "conversation_id": self.conversation_id,
            "description": self.description,
            "visibility": self.visibility,
            "latest_version": self.latest_version,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


def _encode_files(files: dict[str, ShareFile]) -> str:
    """Serialize a bundle to a portable JSON blob (base64 bytes)."""
    return json.dumps(
        {
            f.path: {
                "content_type": f.content_type,
                "b64": base64.b64encode(f.data).decode("ascii"),
            }
            for f in files.values()
        }
    )


def _decode_files(blob: str) -> dict[str, ShareFile]:
    raw = json.loads(blob or "{}")
    return {
        path: ShareFile(
            path=path,
            content_type=meta.get("content_type", "application/octet-stream"),
            data=base64.b64decode(meta.get("b64", "")),
        )
        for path, meta in raw.items()
    }


def _to_share(row: _ShareRow) -> Share:
    return Share(
        uuid=row.uuid,
        owner=row.owner,
        conversation_id=row.conversation_id or "",
        description=row.description or "",
        visibility=row.visibility,
        latest_version=row.latest_version,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _to_version(row: _VersionRow) -> ShareVersion:
    return ShareVersion(
        version=row.version,
        entry_point=row.entry_point,
        files=_decode_files(row.files_json),
        created_at=row.created_at,
    )


class ShareStore:
    """Persists static shares + their versions. Async (asyncpg/aiosqlite).

    Reads/writes rows through the generated scooter_schema.broker models; it does
    NOT create tables (the db-migrator owns schema). Callers use the dataclass API.
    """

    def __init__(self, config: StoreConfig) -> None:
        # pool_pre_ping + pool_recycle: survive a Postgres restart/failover without a
        # dead pooled connection failing the next request. Mirrors registry/store.py.
        self._engine: AsyncEngine = create_async_engine(
            config.resolved_dsn(),
            echo=False,
            pool_pre_ping=True,
            pool_recycle=1800,
        )
        self._session = async_sessionmaker(self._engine, expire_on_commit=False)

    async def get(self, uuid: str) -> Share | None:
        async with self._session() as s:
            row = await s.get(_ShareRow, uuid)
            return _to_share(row) if row else None

    async def get_version(self, uuid: str, version: int | None = None) -> ShareVersion | None:
        """A specific version's files, or the latest when `version` is None.
        Returns None if the share (or that version) doesn't exist."""
        async with self._session() as s:
            share = await s.get(_ShareRow, uuid)
            if share is None:
                return None
            want = version if version is not None else share.latest_version
            row = (
                await s.execute(
                    select(_VersionRow).where(
                        _VersionRow.share_uuid == uuid, _VersionRow.version == want
                    )
                )
            ).scalar_one_or_none()
            return _to_version(row) if row else None

    async def list_by_owner(self, owner: str) -> list[Share]:
        """A caller's own shares, newest-updated first."""
        async with self._session() as s:
            rows = list(
                (await s.execute(select(_ShareRow).where(_ShareRow.owner == owner))).scalars()
            )
        shares = [_to_share(r) for r in rows]
        shares.sort(key=lambda m: m.updated_at, reverse=True)
        return shares

    async def create(
        self,
        *,
        owner: str,
        conversation_id: str,
        description: str,
        visibility: str,
        files: dict[str, ShareFile],
        entry_point: str,
        now_iso: str = "",
    ) -> Share:
        """Mint a new UUID and store version 1. Owner is stamped by the caller
        (the resolved identity), never a request field."""
        new_uuid = str(uuidlib.uuid4())
        async with self._session() as s, s.begin():
            s.add(
                _ShareRow(
                    uuid=new_uuid, owner=owner, conversation_id=conversation_id,
                    description=description, visibility=visibility, latest_version=1,
                    created_at=now_iso, updated_at=now_iso,
                )
            )
            s.add(
                _VersionRow(
                    share_uuid=new_uuid, version=1, entry_point=entry_point,
                    files_json=_encode_files(files), created_at=now_iso,
                )
            )
        return Share(
            uuid=new_uuid, owner=owner, conversation_id=conversation_id,
            description=description, visibility=visibility, latest_version=1,
            created_at=now_iso, updated_at=now_iso,
        )

    async def add_version(
        self,
        uuid: str,
        *,
        owner: str,
        files: dict[str, ShareFile],
        entry_point: str,
        description: str | None = None,
        now_iso: str = "",
    ) -> Share:
        """Update an existing share: add the next version (root then serves it),
        keeping the UUID. Raises KeyError if unknown, PermissionError if not owner."""
        async with self._session() as s, s.begin():
            row = await s.get(_ShareRow, uuid)
            if row is None:
                raise KeyError(uuid)
            if row.owner != owner:
                raise PermissionError(f"share '{uuid}' is owned by another user")
            next_version = row.latest_version + 1
            s.add(
                _VersionRow(
                    share_uuid=uuid, version=next_version, entry_point=entry_point,
                    files_json=_encode_files(files), created_at=now_iso,
                )
            )
            row.latest_version = next_version
            row.updated_at = now_iso
            if description is not None:
                row.description = description
            return _to_share(row)

    async def delete(self, uuid: str, *, owner: str) -> bool:
        """Delete a share and all its versions. Returns False if unknown; raises
        PermissionError if the caller isn't the owner."""
        async with self._session() as s, s.begin():
            row = await s.get(_ShareRow, uuid)
            if row is None:
                return False
            if row.owner != owner:
                raise PermissionError(f"share '{uuid}' is owned by another user")
            for vrow in (
                await s.execute(select(_VersionRow).where(_VersionRow.share_uuid == uuid))
            ).scalars():
                await s.delete(vrow)
            await s.delete(row)
            return True
