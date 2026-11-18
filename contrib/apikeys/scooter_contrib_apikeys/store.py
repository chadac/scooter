"""Each user's API keys, in this contrib's own `contrib_apikeys` database.

The DDL lives in contrib/apikeys/sql/schema.sql (Atlas owns it); this module
never creates tables. Only a digest of each key's secret is stored.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import String, delete, func, select, update
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

from . import keys

MAX_KEYS_PER_USER = 10
DEFAULT_TTL_DAYS = 90
MAX_TTL_DAYS = 365
SCOPES = ("read", "write")
# How often last_used_* may be rewritten per key.
_TOUCH_EVERY = timedelta(minutes=1)
# Unknown key_ids still hash, so misses cost the same.
_MISS_DIGEST = keys.digest("")


class _Base(DeclarativeBase):
    pass


class _Key(_Base):
    __tablename__ = "api_keys"

    key_id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    secret_digest: Mapped[str] = mapped_column(String)
    scopes: Mapped[str] = mapped_column(String)
    created_at: Mapped[str] = mapped_column(String)
    expires_at: Mapped[str] = mapped_column(String)
    last_used_at: Mapped[str | None] = mapped_column(String, nullable=True)
    last_used_ip: Mapped[str | None] = mapped_column(String, nullable=True)


class TooManyKeys(Exception):
    pass


@dataclass(frozen=True)
class KeyInfo:
    key_id: str
    name: str
    scopes: tuple[str, ...]
    created_at: str
    expires_at: str
    last_used_at: str | None
    last_used_ip: str | None

    @staticmethod
    def of(row: _Key) -> "KeyInfo":
        return KeyInfo(row.key_id, row.name, tuple(row.scopes.split(",")), row.created_at,
                       row.expires_at, row.last_used_at, row.last_used_ip)

    def payload(self) -> dict:
        return {
            "key_id": self.key_id, "name": self.name, "scopes": list(self.scopes),
            "created_at": self.created_at, "expires_at": self.expires_at,
            "last_used_at": self.last_used_at, "last_used_ip": self.last_used_ip,
        }


@dataclass(frozen=True)
class Verified:
    user: str
    key_id: str
    scopes: tuple[str, ...]
    expires_at: str


def _iso(t: datetime) -> str:
    # Fixed width, so timestamps compare correctly as strings.
    return t.isoformat(timespec="microseconds")


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ApiKeyStore:
    def __init__(self, config: StoreConfig, now=_now) -> None:
        self._engine, self._session = open_sessions(config)
        self._now = now

    async def list(self, user: str) -> list[KeyInfo]:
        async with self._session() as s:
            rows = (await s.execute(
                select(_Key).where(_Key.user_id == user).order_by(_Key.created_at.desc())
            )).scalars().all()
        return [KeyInfo.of(r) for r in rows]

    async def create(self, user: str, name: str, scopes: tuple[str, ...], ttl_days: int) -> tuple[KeyInfo, str]:
        """The new key's info and its plaintext, which is never available again."""
        now = self._now()
        new = keys.generate()
        row = _Key(
            key_id=new.key_id, user_id=user, name=name, secret_digest=new.digest,
            scopes=",".join(s for s in SCOPES if s in scopes),
            created_at=_iso(now), expires_at=_iso(now + timedelta(days=ttl_days)),
        )
        async with self._session() as s, s.begin():
            # Expired keys are dropped so they free a slot.
            await s.execute(delete(_Key).where(_Key.user_id == user, _Key.expires_at <= _iso(now)))
            live = await s.scalar(select(func.count()).select_from(_Key).where(_Key.user_id == user))
            if (live or 0) >= MAX_KEYS_PER_USER:
                raise TooManyKeys
            s.add(row)
        return KeyInfo.of(row), new.plaintext

    async def revoke(self, user: str, key_id: str) -> bool:
        async with self._session() as s, s.begin():
            result = await s.execute(delete(_Key).where(_Key.user_id == user, _Key.key_id == key_id))
        return result.rowcount > 0

    async def verify(self, key: str, ip: str | None) -> Verified | None:
        """The key's owner and scopes; None for a malformed, unknown, expired or wrong key alike."""
        parsed = keys.parse(key)
        key_id, secret = parsed if parsed else ("", key)
        async with self._session() as s:
            row = await s.get(_Key, key_id) if key_id else None
        ok = keys.matches(secret, row.secret_digest if row else _MISS_DIGEST)
        now = self._now()
        if not ok or row is None or datetime.fromisoformat(row.expires_at) <= now:
            return None
        last = datetime.fromisoformat(row.last_used_at) if row.last_used_at else None
        if last is None or now - last >= _TOUCH_EVERY or row.last_used_ip != ip:
            async with self._session() as s, s.begin():
                await s.execute(update(_Key).where(_Key.key_id == key_id)
                                .values(last_used_at=_iso(now), last_used_ip=ip))
        return Verified(row.user_id, row.key_id, tuple(row.scopes.split(",")), row.expires_at)
