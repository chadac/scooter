"""Each user's SSH key, in this contrib's own `contrib_ssh` database.

The DDL lives in contrib/ssh/sql/schema.sql (Atlas owns it); this module never
creates tables. The private seed is stored sealed, bound to the user it belongs to.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import String, Text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions
from scooter_broker_lib.user_secrets import SecretBox

from .keys import KeyPair, fingerprint


class _Base(DeclarativeBase):
    pass


class _Key(_Base):
    __tablename__ = "ssh_keys"

    user_id: Mapped[str] = mapped_column(String, primary_key=True)
    public_key: Mapped[str] = mapped_column(Text)
    fingerprint: Mapped[str] = mapped_column(String)
    private_key: Mapped[str] = mapped_column(Text)
    created_at: Mapped[str] = mapped_column(String)


@dataclass(frozen=True)
class UserKey:
    user_id: str
    pair: KeyPair
    public_key: str
    fingerprint: str
    created_at: str

    def payload(self) -> dict:
        return {"public_key": self.public_key, "fingerprint": self.fingerprint, "created_at": self.created_at}


def comment_for(user_id: str) -> str:
    # The user id is an email or a login, either fine in a key comment.
    return f"{user_id} (scooter)"


def _context(user_id: str) -> str:
    return f"ssh:{user_id}"


class SshKeyStore:
    def __init__(self, config: StoreConfig, box: SecretBox) -> None:
        self._engine, self._session = open_sessions(config)
        self._box = box

    async def _load(self, row: _Key) -> UserKey:
        seed = base64.b64decode(await self._box.open(row.private_key, _context(row.user_id)))
        return UserKey(row.user_id, KeyPair(seed), row.public_key, row.fingerprint, row.created_at)

    async def _row(self, user_id: str, pair: KeyPair) -> _Key:
        return _Key(
            user_id=user_id,
            public_key=pair.authorized_key(comment_for(user_id)),
            fingerprint=fingerprint(pair.blob),
            private_key=await self._box.seal(base64.b64encode(pair.seed).decode(), _context(user_id)),
            created_at=datetime.now(timezone.utc).isoformat(),
        )

    async def get(self, user_id: str) -> UserKey | None:
        async with self._session() as s:
            row = await s.get(_Key, user_id)
        return await self._load(row) if row else None

    async def get_or_create(self, user_id: str) -> tuple[UserKey, bool]:
        """The user's key and whether this call created it."""
        existing = await self.get(user_id)
        if existing is not None:
            return existing, False
        row = await self._row(user_id, KeyPair.generate())
        try:
            async with self._session() as s, s.begin():
                s.add(row)
        except IntegrityError:
            # A concurrent first visit created it: keep theirs.
            found = await self.get(user_id)
            assert found is not None
            return found, False
        return await self._load(row), True

    async def rotate(self, user_id: str) -> tuple[UserKey | None, UserKey]:
        """Replace the user's key with a fresh one; returns (old, new)."""
        old = await self.get(user_id)
        fresh = await self._row(user_id, KeyPair.generate())
        async with self._session() as s, s.begin():
            await s.merge(fresh)
        return old, await self._load(fresh)

