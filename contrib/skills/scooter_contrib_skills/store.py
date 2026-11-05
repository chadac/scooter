"""Skill sources, in this contrib's own `contrib_skills` database.

The DDL lives in contrib/skills/sql/schema.sql (Atlas owns it); this module never
creates tables.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, replace
from datetime import datetime, timezone

from sqlalchemy import Boolean, String, Text, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

KINDS = ("skills.sh", "github")
# Every conversation installs them all.
MAX_SOURCES = 20

# argv-safe: no leading dash, whitespace or shell metacharacters.
_SKILLS_SH = re.compile(r"^(?!-)[A-Za-z0-9@._/:#~+-]{1,200}$")
# owner/repo[/path][@ref], optionally as a github.com URL.
_GITHUB = re.compile(
    r"^(https://github\.com/)?[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_./-]+)?(@[A-Za-z0-9_./-]+)?/?$"
)
_SKILL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class _Base(DeclarativeBase):
    pass


class _Source(_Base):
    __tablename__ = "skill_sources"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    owner: Mapped[str] = mapped_column(String, index=True)
    kind: Mapped[str] = mapped_column(String)
    spec: Mapped[str] = mapped_column(String)
    skills: Mapped[str] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


class InvalidSource(ValueError):
    """A rejected write; the message is shown in the settings form."""


@dataclass(frozen=True)
class Source:
    id: str
    kind: str
    spec: str
    skills: tuple[str, ...]
    enabled: bool
    created_at: str
    updated_at: str

    def payload(self) -> dict:
        return {
            "id": self.id, "kind": self.kind, "spec": self.spec, "skills": list(self.skills),
            "enabled": self.enabled, "created_at": self.created_at, "updated_at": self.updated_at,
        }

    def sandbox_payload(self) -> dict:
        return {"kind": self.kind, "spec": self.spec, "skills": list(self.skills)}


def parse_filter(raw: object) -> tuple[str, ...]:
    """A list or comma-separated string of skill names, trimmed and deduped."""
    parts = raw if isinstance(raw, list) else str(raw or "").split(",")
    return tuple(dict.fromkeys(p.strip() for p in parts if isinstance(p, str) and p.strip()))


def validate(kind: str, spec: str, skills: tuple[str, ...]) -> None:
    if kind not in KINDS:
        raise InvalidSource(f"kind must be one of {', '.join(KINDS)}")
    if kind == "skills.sh" and not _SKILLS_SH.match(spec):
        raise InvalidSource(
            "a skills.sh source is what you would pass to `npx skills add`, e.g. vercel-labs/agent-skills"
        )
    if kind == "github" and (not _GITHUB.match(spec) or ".." in spec):
        raise InvalidSource(
            "a GitHub source is owner/repo, optionally with /path and @ref, e.g. anthropics/skills/skills@main"
        )
    bad = next((s for s in skills if not _SKILL_NAME.match(s)), None)
    if bad is not None:
        raise InvalidSource(f'"{bad}" is not a skill name')


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _source(row: _Source) -> Source:
    return Source(
        id=row.id, kind=row.kind, spec=row.spec, skills=parse_filter(row.skills),
        enabled=row.enabled, created_at=row.created_at, updated_at=row.updated_at,
    )


class SkillSourceStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine, self._session = open_sessions(config)

    async def list(self, owner: str, *, enabled_only: bool = False) -> list[Source]:
        stmt = select(_Source).where(_Source.owner == owner)
        if enabled_only:
            stmt = stmt.where(_Source.enabled.is_(True))
        async with self._session() as s:
            rows = (await s.execute(stmt.order_by(_Source.created_at))).scalars()
            return [_source(r) for r in rows]

    async def _guard(self, owner: str, src: Source) -> None:
        validate(src.kind, src.spec, src.skills)
        others = [s for s in await self.list(owner) if s.id != src.id]
        if any(s.kind == src.kind and s.spec == src.spec for s in others):
            raise InvalidSource(f'you already have the {src.kind} source "{src.spec}"')
        if len(others) + 1 > MAX_SOURCES:
            raise InvalidSource(f"at most {MAX_SOURCES} skill sources per user")

    async def create(self, owner: str, *, kind: str, spec: str, skills: tuple[str, ...], enabled: bool = True) -> Source:
        now = _now()
        src = Source(uuid.uuid4().hex, kind, spec.strip(), skills, enabled, now, now)
        await self._guard(owner, src)
        try:
            async with self._session() as s, s.begin():
                s.add(_Source(owner=owner, **{**src.payload(), "skills": ",".join(src.skills)}))
        except IntegrityError as e:
            raise InvalidSource(f'you already have the {kind} source "{src.spec}"') from e
        return src

    async def update(self, owner: str, source_id: str, **fields) -> Source | None:
        """Patch one of the owner's sources; None if it is not theirs."""
        current = next((s for s in await self.list(owner) if s.id == source_id), None)
        if current is None:
            return None
        if "spec" in fields:
            fields["spec"] = fields["spec"].strip()
        nxt = replace(current, **fields, updated_at=_now())
        await self._guard(owner, nxt)
        try:
            async with self._session() as s, s.begin():
                row = await s.get(_Source, source_id)
                if row is None or row.owner != owner:
                    return None
                row.kind, row.spec, row.skills = nxt.kind, nxt.spec, ",".join(nxt.skills)
                row.enabled, row.updated_at = nxt.enabled, nxt.updated_at
        except IntegrityError as e:
            raise InvalidSource(f'you already have the {nxt.kind} source "{nxt.spec}"') from e
        return nxt

    async def delete(self, owner: str, source_id: str) -> bool:
        async with self._session() as s, s.begin():
            row = await s.get(_Source, source_id)
            if row is None or row.owner != owner:
                return False
            await s.delete(row)
            return True
