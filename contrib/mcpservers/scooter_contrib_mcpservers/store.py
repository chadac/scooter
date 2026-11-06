"""MCP servers, in this contrib's own `contrib_mcpservers` database.

The DDL lives in contrib/mcpservers/sql/schema.sql (Atlas owns it); this module never
creates tables.
"""

from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone

from sqlalchemy import Boolean, String, Text, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

KINDS = ("npm", "pypi", "nixpkgs")
# The sandbox reserves 20 ports for them.
MAX_SERVERS = 20
MAX_ARGS = 32
MAX_ARG_LEN = 500

# Must be valid inside a tool name.
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$")
# A package, optionally scoped, with an optional @version.
_NPM = re.compile(r"^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*(@[A-Za-z0-9._~^<>=*-]+)?$")
# A PyPI name, optional extras, optional ==version or @version.
_PYPI = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9,._-]+\])?((==|@)[A-Za-z0-9.!+_-]+)?$")
# A nixpkgs attribute path, e.g. python3Packages.mcp-server-fetch.
_NIX_ATTR = re.compile(r"^[A-Za-z_][A-Za-z0-9_'-]*(\.[A-Za-z_][A-Za-z0-9_'-]*)*$")
_SPEC = {"npm": _NPM, "pypi": _PYPI, "nixpkgs": _NIX_ATTR}
_SPEC_HINT = {
    "npm": "an npm package, optionally @version, e.g. @modelcontextprotocol/server-everything",
    "pypi": "a PyPI package, optionally ==version, e.g. mcp-server-fetch",
    "nixpkgs": "a nixpkgs attribute, e.g. mcp-server-time",
}


class _Base(DeclarativeBase):
    pass


class _Server(_Base):
    __tablename__ = "mcp_servers"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    owner: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String)
    spec: Mapped[str] = mapped_column(String)
    args: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


class InvalidServer(ValueError):
    """A rejected write; the message is shown in the settings form."""


@dataclass(frozen=True)
class Server:
    id: str
    name: str
    kind: str
    spec: str
    args: tuple[str, ...]
    enabled: bool
    created_at: str
    updated_at: str

    def payload(self) -> dict:
        return {
            "id": self.id, "name": self.name, "kind": self.kind, "spec": self.spec,
            "args": list(self.args), "enabled": self.enabled,
            "created_at": self.created_at, "updated_at": self.updated_at,
        }

    def sandbox_payload(self) -> dict:
        return {"name": self.name, "kind": self.kind, "spec": self.spec, "args": list(self.args)}


def parse_args(raw: object) -> tuple[str, ...]:
    """A JSON-style list of argv strings; anything else is rejected."""
    if raw is None:
        return ()
    if not isinstance(raw, list) or not all(isinstance(a, str) for a in raw):
        raise InvalidServer("args must be a list of strings")
    return tuple(raw)


def validate(name: str, kind: str, spec: str, args: tuple[str, ...]) -> None:
    if not _NAME.match(name):
        raise InvalidServer("a name is up to 32 letters, digits, '_' or '-', starting with a letter or digit")
    if kind not in KINDS:
        raise InvalidServer(f"kind must be one of {', '.join(KINDS)}")
    if not _SPEC[kind].match(spec):
        raise InvalidServer(f"expected {_SPEC_HINT[kind]}")
    if len(args) > MAX_ARGS:
        raise InvalidServer(f"at most {MAX_ARGS} arguments")
    bad = next((a for a in args if len(a) > MAX_ARG_LEN or any(c in a for c in "\0\n\r")), None)
    if bad is not None:
        raise InvalidServer(f"arguments are at most {MAX_ARG_LEN} characters, on one line")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _server(row: _Server) -> Server:
    return Server(
        id=row.id, name=row.name, kind=row.kind, spec=row.spec, args=tuple(json.loads(row.args or "[]")),
        enabled=row.enabled, created_at=row.created_at, updated_at=row.updated_at,
    )


def _taken(name: str) -> InvalidServer:
    return InvalidServer(f'you already have an MCP server named "{name}"')


class McpServerStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine, self._session = open_sessions(config)

    async def list(self, owner: str, *, enabled_only: bool = False) -> list[Server]:
        stmt = select(_Server).where(_Server.owner == owner)
        if enabled_only:
            stmt = stmt.where(_Server.enabled.is_(True))
        async with self._session() as s:
            rows = (await s.execute(stmt.order_by(_Server.created_at))).scalars()
            return [_server(r) for r in rows]

    async def _guard(self, owner: str, srv: Server) -> None:
        validate(srv.name, srv.kind, srv.spec, srv.args)
        others = [s for s in await self.list(owner) if s.id != srv.id]
        if any(s.name == srv.name for s in others):
            raise _taken(srv.name)
        if len(others) + 1 > MAX_SERVERS:
            raise InvalidServer(f"at most {MAX_SERVERS} MCP servers per user")

    async def create(
        self, owner: str, *, name: str, kind: str, spec: str, args: tuple[str, ...] = (), enabled: bool = True
    ) -> Server:
        now = _now()
        srv = Server(uuid.uuid4().hex, name.strip(), kind, spec.strip(), args, enabled, now, now)
        await self._guard(owner, srv)
        try:
            async with self._session() as s, s.begin():
                s.add(_Server(owner=owner, **{**srv.payload(), "args": json.dumps(list(srv.args))}))
        except IntegrityError as e:
            raise _taken(srv.name) from e
        return srv

    async def update(self, owner: str, server_id: str, **fields) -> Server | None:
        """Patch one of the owner's servers; None if it is not theirs."""
        current = next((s for s in await self.list(owner) if s.id == server_id), None)
        if current is None:
            return None
        for key in ("name", "spec"):
            if key in fields:
                fields[key] = fields[key].strip()
        nxt = replace(current, **fields, updated_at=_now())
        await self._guard(owner, nxt)
        try:
            async with self._session() as s, s.begin():
                row = await s.get(_Server, server_id)
                if row is None or row.owner != owner:
                    return None
                row.name, row.kind, row.spec, row.args = nxt.name, nxt.kind, nxt.spec, json.dumps(list(nxt.args))
                row.enabled, row.updated_at = nxt.enabled, nxt.updated_at
        except IntegrityError as e:
            raise _taken(nxt.name) from e
        return nxt

    async def delete(self, owner: str, server_id: str) -> bool:
        async with self._session() as s, s.begin():
            row = await s.get(_Server, server_id)
            if row is None or row.owner != owner:
                return False
            await s.delete(row)
            return True
