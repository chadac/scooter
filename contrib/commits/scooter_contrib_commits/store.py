"""Each user's commit identity, in this contrib's own `contrib_commits` database.

The DDL lives in contrib/commits/sql/schema.sql (Atlas owns it); this module never
creates tables. The user may always overwrite an identity. An agent only proposes
one (./approvals.py), and the user's approval writes it if none is set by then.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import String, delete
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.commit_identity import Person
from scooter_broker_lib.store import StoreConfig, open_sessions

SET_BY = ("user", "agent")

# Git idents cannot hold <, > or newlines.
_NAME = re.compile(r"^[^<>\n\r\x00]{1,200}$")
_EMAIL = re.compile(r"^[^\s<>@]{1,200}@[^\s<>@]{1,200}$")


class InvalidIdentity(ValueError):
    pass


class Refused(Exception):
    """An approval that cannot apply; the message says why."""


def validated(name: str, email: str) -> Person:
    name, email = (name or "").strip(), (email or "").strip()
    if not _NAME.match(name):
        raise InvalidIdentity("name must be one line of 1-200 characters, without < or >")
    if not _EMAIL.match(email):
        raise InvalidIdentity("email must look like user@host")
    return Person(name, email)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class _Base(DeclarativeBase):
    pass


class _Identity(_Base):
    __tablename__ = "commit_identities"

    user_id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String)
    email: Mapped[str] = mapped_column(String)
    set_by: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


@dataclass(frozen=True)
class ChosenIdentity:
    person: Person
    set_by: str
    updated_at: str

    def payload(self) -> dict:
        return {"name": self.person.name, "email": self.person.email, "set_by": self.set_by, "updated_at": self.updated_at}


def _chosen(row: _Identity) -> ChosenIdentity:
    return ChosenIdentity(Person(row.name, row.email), row.set_by, row.updated_at)


def _row(user_id: str, person: Person, set_by: str) -> _Identity:
    return _Identity(user_id=user_id, name=person.name, email=person.email, set_by=set_by, updated_at=_now())


class CommitIdentityStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine, self._session = open_sessions(config)

    async def get(self, user_id: str) -> ChosenIdentity | None:
        async with self._session() as s:
            row = await s.get(_Identity, user_id)
        return _chosen(row) if row else None

    async def set(self, user_id: str, person: Person) -> ChosenIdentity:
        """The user's own choice: replaces any identity."""
        row = _row(user_id, person, "user")
        async with self._session() as s, s.begin():
            await s.merge(row)
        return _chosen(row)

    async def clear(self, user_id: str) -> None:
        async with self._session() as s, s.begin():
            await s.execute(delete(_Identity).where(_Identity.user_id == user_id))

    async def adopt(self, user_id: str, person: Person) -> ChosenIdentity:
        """An approved proposal; Refused if an identity is set first, which the key enforces."""
        row = _row(user_id, person, "agent")
        try:
            async with self._session() as s, s.begin():
                s.add(row)
        except IntegrityError:
            raise Refused("an identity was set first") from None
        return _chosen(row)
