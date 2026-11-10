"""Card store, in this contrib's own `contrib_kanban` database.

The DDL lives in contrib/kanban/sql/schema.sql (Atlas owns it); this module never
creates tables. A card is keyed by the broker's conversation key, so the agent's
tools and the board's relay routes address the same row. A card's stage is the
folder its conversation is filed in, which the router holds; this store keeps
which folders are boards and stages.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from sqlalchemy import Boolean, Float, Integer, String, Text, delete, func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

MAX_NOTE_CHARS = 280
MAX_DESCRIPTION_CHARS = 10_000
# A priority's name is its index, as kanban_card_details stores it.
PRIORITIES = ("none", "low", "medium", "high", "urgent")
# What a gate checks: the user approves, or a script passes in the card's sandbox.
GATE_KINDS = ("approval", "command")
MAX_GATE_DETAIL_CHARS = 4_000


class _Base(DeclarativeBase):
    pass


class _Card(_Base):
    """Mirrors `kanban_cards` in contrib/kanban/sql/schema.sql."""

    __tablename__ = "kanban_cards"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    column_id: Mapped[str] = mapped_column(String)
    position: Mapped[float] = mapped_column(Float)
    note: Mapped[str] = mapped_column(Text, default="")
    updated_by: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


class _Board(_Base):
    """Mirrors `kanban_boards` in contrib/kanban/sql/schema.sql."""

    __tablename__ = "kanban_boards"

    folder_id: Mapped[str] = mapped_column(String, primary_key=True)
    owner: Mapped[str] = mapped_column(String, index=True)
    created_at: Mapped[str] = mapped_column(String)


class _Stage(_Base):
    """Mirrors `kanban_stages` in contrib/kanban/sql/schema.sql."""

    __tablename__ = "kanban_stages"

    folder_id: Mapped[str] = mapped_column(String, primary_key=True)
    board_id: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str] = mapped_column(String)
    position: Mapped[float] = mapped_column(Float)


class _Blocker(_Base):
    """Mirrors `kanban_blockers` in contrib/kanban/sql/schema.sql."""

    __tablename__ = "kanban_blockers"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    blocker_id: Mapped[str] = mapped_column(String, primary_key=True, index=True)
    created_by: Mapped[str] = mapped_column(String)
    created_at: Mapped[str] = mapped_column(String)


class _Tag(_Base):
    """Mirrors `kanban_tags` in contrib/kanban/sql/schema.sql."""

    __tablename__ = "kanban_tags"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    board_id: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str] = mapped_column(String)
    color: Mapped[str] = mapped_column(String)
    position: Mapped[float] = mapped_column(Float)


class _Skill(_Base):
    """Mirrors `kanban_skills` in contrib/kanban/sql/schema.sql."""

    __tablename__ = "kanban_skills"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    board_id: Mapped[str] = mapped_column(String, index=True)
    name: Mapped[str] = mapped_column(String)
    body: Mapped[str] = mapped_column(Text)
    position: Mapped[float] = mapped_column(Float)


class _Gate(_Base):
    """Mirrors `kanban_gates` in contrib/kanban/sql/schema.sql."""

    __tablename__ = "kanban_gates"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    board_id: Mapped[str] = mapped_column(String, index=True)
    stage_id: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String)
    name: Mapped[str] = mapped_column(String)
    command: Mapped[str] = mapped_column(Text, default="")
    workdir: Mapped[str] = mapped_column(String, default="")
    clean: Mapped[bool] = mapped_column(Boolean, default=True)
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=600)
    position: Mapped[float] = mapped_column(Float)


class _GateResult(_Base):
    """Mirrors `kanban_gate_results` in contrib/kanban/sql/schema.sql."""

    __tablename__ = "kanban_gate_results"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    gate_id: Mapped[str] = mapped_column(String, primary_key=True, index=True)
    state: Mapped[str] = mapped_column(String)
    detail: Mapped[str] = mapped_column(Text, default="")
    commit: Mapped[str] = mapped_column(String, default="")
    updated_by: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


class _CardTag(_Base):
    """Mirrors `kanban_card_tags` in contrib/kanban/sql/schema.sql."""

    __tablename__ = "kanban_card_tags"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    tag_id: Mapped[str] = mapped_column(String, primary_key=True, index=True)


class _Details(_Base):
    """Mirrors `kanban_card_details` in contrib/kanban/sql/schema.sql."""

    __tablename__ = "kanban_card_details"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    description: Mapped[str] = mapped_column(Text, default="")
    priority: Mapped[int] = mapped_column(Integer, default=0)
    updated_by: Mapped[str] = mapped_column(String)
    updated_at: Mapped[str] = mapped_column(String)


@dataclass(frozen=True)
class Details:
    description: str = ""
    priority: int = 0
    updated_by: str = ""
    updated_at: str = ""

    def payload(self) -> dict:
        return {**asdict(self), "priority": PRIORITIES[self.priority]}


@dataclass(frozen=True)
class Stage:
    folder: str
    name: str
    position: float

    def payload(self) -> dict:
        return {"id": self.folder, "label": self.name, "position": self.position}


@dataclass(frozen=True)
class Tag:
    id: str
    name: str
    color: str
    position: float

    def payload(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Skill:
    """A note the user wrote for every agent on a board."""

    id: str
    name: str
    body: str
    position: float

    def payload(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Gate:
    """A check a card must pass before the agent moves it on from `stage`."""

    id: str
    stage: str
    kind: str
    name: str
    position: float = 0.0
    command: str = ""
    workdir: str = ""
    clean: bool = True
    timeout_seconds: int = 600

    def payload(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class GateResult:
    """Where a card stands on one gate."""

    gate: str
    state: str
    detail: str = ""
    commit: str = ""
    updated_by: str = ""
    updated_at: str = ""

    def payload(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class Place:
    """Where a folder sits on a board: the board root has no stage."""

    board: str
    owner: str
    stage: str | None


@dataclass
class Card:
    conversation_id: str
    column: str
    position: float
    note: str
    updated_by: str
    updated_at: str

    def payload(self) -> dict:
        return asdict(self)


@dataclass
class BoardView:
    """Card state by card key; keys with nothing stored are absent."""

    cards: dict[str, Card] = field(default_factory=dict)
    tags: dict[str, list[str]] = field(default_factory=dict)
    details: dict[str, Details] = field(default_factory=dict)
    blockers: dict[str, list[str]] = field(default_factory=dict)
    # Ids of the gates each card awaits the user's approval on.
    pending: dict[str, list[str]] = field(default_factory=dict)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _card(row: _Card) -> Card:
    return Card(
        conversation_id=row.conversation_id, column=row.column_id, position=row.position,
        note=row.note or "", updated_by=row.updated_by, updated_at=row.updated_at,
    )


class KanbanStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine: AsyncEngine
        self._engine, self._session = open_sessions(config)
        # The session `reading` shares; the lock serialises its queries.
        self._shared: ContextVar[tuple[AsyncSession, asyncio.Lock] | None] = ContextVar(
            f"kanban-session-{id(self)}", default=None
        )

    @asynccontextmanager
    async def reading(self) -> AsyncIterator[None]:
        """Run every read in this block, and the tasks it starts, on one session; writes keep their own."""
        if self._shared.get() is not None:
            yield
            return
        async with self._session() as s:
            token = self._shared.set((s, asyncio.Lock()))
            try:
                yield
            finally:
                self._shared.reset(token)

    @asynccontextmanager
    async def _read(self) -> AsyncIterator[AsyncSession]:
        shared = self._shared.get()
        if shared is None:
            async with self._session() as s:
                yield s
            return
        s, lock = shared
        async with lock:
            try:
                yield s
            finally:
                # Drop cached rows so other sessions' writes stay visible.
                s.expunge_all()

    async def card(self, conversation_id: str) -> Card | None:
        async with self._read() as s:
            row = await s.get(_Card, conversation_id)
            return _card(row) if row else None

    async def put(
        self,
        conversation_id: str,
        *,
        column: str,
        by: str,
        note: str | None = None,
        position: float | None = None,
        now: str | None = None,
    ) -> Card:
        """Move, reorder or confirm a card; None keeps the note, and keeps the position unless the column changed.

        A new position in the same column with no note is a reorder: it keeps who updated
        the card and when, so it neither claims the status nor resets its staleness.
        """
        async with self._session() as s, s.begin():
            row = await s.get(_Card, conversation_id)
            reorder = row is not None and row.column_id == column and note is None and position is not None
            if position is None and (row is None or row.column_id != column):
                # A card entering a column lands at its top.
                top = await s.scalar(select(func.min(_Card.position)).where(_Card.column_id == column))
                position = 0.0 if top is None else top - 1.0
            if row is None:
                row = _Card(conversation_id=conversation_id, column_id=column, position=0.0, note="")
                s.add(row)
            row.column_id = column
            row.position = position if position is not None else row.position
            if note is not None:
                row.note = note[:MAX_NOTE_CHARS]
            if not reorder:
                row.updated_by = by
                row.updated_at = now or now_iso()
            await s.flush()
            return _card(row)

    async def boards(self, owner: str) -> list[str]:
        """The folder ids of `owner`'s boards, oldest first."""
        async with self._read() as s:
            rows = await s.execute(
                select(_Board.folder_id).where(_Board.owner == owner).order_by(_Board.created_at)
            )
            return list(rows.scalars())

    async def is_board(self, folder_id: str) -> bool:
        async with self._read() as s:
            return await s.get(_Board, folder_id) is not None

    async def add_board(self, owner: str, folder_id: str) -> None:
        """Record a board kanban made; one already recorded is left alone."""
        async with self._session() as s, s.begin():
            if await s.get(_Board, folder_id) is None:
                s.add(_Board(folder_id=folder_id, owner=owner, created_at=now_iso()))

    async def board_owner(self, folder_id: str) -> str | None:
        async with self._read() as s:
            row = await s.get(_Board, folder_id)
            return row.owner if row else None

    async def place(self, folder_id: str) -> Place | None:
        """The board a folder belongs to, as its root or one of its stages; None off every board."""
        async with self._read() as s:
            board = await s.get(_Board, folder_id)
            if board is not None:
                return Place(board=board.folder_id, owner=board.owner, stage=None)
            stage = await s.get(_Stage, folder_id)
            board = await s.get(_Board, stage.board_id) if stage else None
            return Place(board=board.folder_id, owner=board.owner, stage=stage.folder_id) if board else None

    async def layout(
        self, owner: str, board_id: str | None = None
    ) -> list[tuple[str, list[Stage], list[Tag], list[Skill]]]:
        """`owner`'s boards, oldest first, with their stages, tags and skills; only `board_id` when given."""
        async with self._read() as s:
            q = select(_Board.folder_id).where(_Board.owner == owner)
            if board_id is not None:
                q = q.where(_Board.folder_id == board_id)
            boards = list((await s.execute(q.order_by(_Board.created_at))).scalars())
            stages: dict[str, list[Stage]] = {b: [] for b in boards}
            tags: dict[str, list[Tag]] = {b: [] for b in boards}
            skills: dict[str, list[Skill]] = {b: [] for b in boards}
            rows = await s.execute(
                select(_Stage).where(_Stage.board_id.in_(boards)).order_by(_Stage.position, _Stage.folder_id)
            )
            for r in rows.scalars():
                stages[r.board_id].append(Stage(folder=r.folder_id, name=r.name, position=r.position))
            rows = await s.execute(select(_Tag).where(_Tag.board_id.in_(boards)).order_by(_Tag.position, _Tag.id))
            for r in rows.scalars():
                tags[r.board_id].append(_tag(r))
            rows = await s.execute(
                select(_Skill).where(_Skill.board_id.in_(boards)).order_by(_Skill.position, _Skill.id)
            )
            for r in rows.scalars():
                skills[r.board_id].append(_skill(r))
            return [(b, stages[b], tags[b], skills[b]) for b in boards]

    async def save_board(
        self,
        board_id: str,
        stages: list[Stage],
        tags: list[Tag],
        skills: list[Skill] | None = None,
        gates: list[Gate] | None = None,
    ) -> list[Tag]:
        """Make a board's stages, tags, skills and gates these, in one transaction; one without an id is new.

        Stages, tags, skills and gates not listed are deleted, deleted tags come off every card, and
        a deleted stage takes its gates. `skills` or `gates` None leaves them as they are. Returns
        the tags as stored, new ones with their ids.
        """
        async with self._session() as s, s.begin():
            have = {r.folder_id: r for r in (await s.execute(select(_Stage).where(_Stage.board_id == board_id))).scalars()}
            keep = {st.folder for st in stages}
            await s.execute(delete(_Stage).where(_Stage.board_id == board_id, _Stage.folder_id.not_in(keep)))
            for st in stages:
                row = have.get(st.folder)
                if row is None:
                    s.add(_Stage(folder_id=st.folder, board_id=board_id, name=st.name, position=st.position))
                else:
                    # Only changed fields are written.
                    row.name, row.position = st.name, st.position
            rows = {r.id: r for r in (await s.execute(select(_Tag).where(_Tag.board_id == board_id))).scalars()}
            want = {t.id for t in tags}
            gone = [t for t in rows if t not in want]
            await s.execute(delete(_CardTag).where(_CardTag.tag_id.in_(gone)))
            await s.execute(delete(_Tag).where(_Tag.id.in_(gone)))
            out: list[Tag] = []
            for t in tags:
                row = rows.get(t.id)
                if row is None:
                    row = _Tag(id=str(uuid.uuid4()), board_id=board_id)
                    s.add(row)
                row.name, row.color, row.position = t.name, t.color, t.position
                out.append(_tag(row))
            if skills is not None:
                await self._write_skills(s, board_id, skills)
            if gates is not None:
                await self._write_gates(s, board_id, gates)
            # A stage that went takes its gates.
            gone_gates = select(_Gate.id).where(_Gate.board_id == board_id, _Gate.stage_id.not_in(keep))
            await s.execute(delete(_GateResult).where(_GateResult.gate_id.in_(gone_gates)))
            await s.execute(delete(_Gate).where(_Gate.board_id == board_id, _Gate.stage_id.not_in(keep)))
            return out

    @staticmethod
    async def _write_gates(s, board_id: str, gates: list[Gate]) -> None:
        have = {r.id: r for r in (await s.execute(select(_Gate).where(_Gate.board_id == board_id))).scalars()}
        keep = [g.id for g in gates if g.id in have]
        gone = [i for i in have if i not in keep]
        await s.execute(delete(_GateResult).where(_GateResult.gate_id.in_(gone)))
        await s.execute(delete(_Gate).where(_Gate.id.in_(gone)))
        for g in gates:
            row = have.get(g.id)
            if row is None:
                row = _Gate(id=str(uuid.uuid4()), board_id=board_id)
                s.add(row)
            elif (row.kind, row.command, row.workdir, row.clean) != (g.kind, g.command, g.workdir, g.clean):
                # What passed before is no longer what the gate checks.
                await s.execute(delete(_GateResult).where(_GateResult.gate_id == row.id))
            row.stage_id, row.kind, row.name, row.position = g.stage, g.kind, g.name, g.position
            row.command, row.workdir, row.clean, row.timeout_seconds = g.command, g.workdir, g.clean, g.timeout_seconds

    async def save_skills(self, board_id: str, skills: list[Skill]) -> None:
        """Make a board's skills these, leaving its stages and tags; a skill without an id is new."""
        async with self._session() as s, s.begin():
            await self._write_skills(s, board_id, skills)

    @staticmethod
    async def _write_skills(s, board_id: str, skills: list[Skill]) -> None:
        have = {r.id: r for r in (await s.execute(select(_Skill).where(_Skill.board_id == board_id))).scalars()}
        keep = [k.id for k in skills if k.id in have]
        await s.execute(delete(_Skill).where(_Skill.board_id == board_id, _Skill.id.not_in(keep)))
        for k in skills:
            row = have.get(k.id)
            if row is None:
                row = _Skill(id=str(uuid.uuid4()), board_id=board_id)
                s.add(row)
            row.name, row.body, row.position = k.name, k.body, k.position

    async def gates(self, board_id: str) -> list[Gate]:
        """A board's gates, in board order within each stage."""
        async with self._read() as s:
            rows = await s.execute(
                select(_Gate).where(_Gate.board_id == board_id).order_by(_Gate.position, _Gate.id)
            )
            return [_gate(r) for r in rows.scalars()]

    async def gate_results(self, conversation_id: str) -> dict[str, GateResult]:
        """Where a card stands on each gate it has met, by gate id."""
        async with self._read() as s:
            rows = await s.execute(select(_GateResult).where(_GateResult.conversation_id == conversation_id))
            return {r.gate_id: _result(r) for r in rows.scalars()}

    async def put_result(
        self, conversation_id: str, gate_id: str, *, state: str, by: str, detail: str = "", commit: str = "",
        now: str | None = None,
    ) -> GateResult:
        """Record a card's standing on a gate, replacing what was there."""
        async with self._session() as s, s.begin():
            row = await s.get(_GateResult, (conversation_id, gate_id))
            if row is None:
                row = _GateResult(conversation_id=conversation_id, gate_id=gate_id)
                s.add(row)
            row.state, row.detail, row.commit = state, detail[-MAX_GATE_DETAIL_CHARS:], commit
            row.updated_by, row.updated_at = by, now or now_iso()
            await s.flush()
            return _result(row)

    async def clear_results(self, conversation_id: str, gate_ids: list[str]) -> None:
        """Forget a card's standing on these gates, e.g. once it has moved past them."""
        if not gate_ids:
            return
        async with self._session() as s, s.begin():
            await s.execute(
                delete(_GateResult).where(
                    _GateResult.conversation_id == conversation_id, _GateResult.gate_id.in_(gate_ids)
                )
            )

    async def stages(self, board_id: str) -> list[Stage]:
        """A board's stages in board order."""
        async with self._read() as s:
            rows = await s.execute(
                select(_Stage).where(_Stage.board_id == board_id).order_by(_Stage.position, _Stage.folder_id)
            )
            return [Stage(folder=r.folder_id, name=r.name, position=r.position) for r in rows.scalars()]

    async def add_stage(self, board_id: str, folder_id: str, name: str, position: float) -> None:
        async with self._session() as s, s.begin():
            s.add(_Stage(folder_id=folder_id, board_id=board_id, name=name, position=position))

    async def remove_board(self, owner: str, folder_id: str) -> bool:
        async with self._session() as s, s.begin():
            res = await s.execute(delete(_Board).where(_Board.folder_id == folder_id, _Board.owner == owner))
            if res.rowcount == 0:
                return False
            await s.execute(delete(_Stage).where(_Stage.board_id == folder_id))
            tags = select(_Tag.id).where(_Tag.board_id == folder_id)
            await s.execute(delete(_CardTag).where(_CardTag.tag_id.in_(tags)))
            await s.execute(delete(_Tag).where(_Tag.board_id == folder_id))
            await s.execute(delete(_Skill).where(_Skill.board_id == folder_id))
            gates = select(_Gate.id).where(_Gate.board_id == folder_id)
            await s.execute(delete(_GateResult).where(_GateResult.gate_id.in_(gates)))
            await s.execute(delete(_Gate).where(_Gate.board_id == folder_id))
            return True

    async def blockers(self, conversation_id: str) -> list[str]:
        """The keys of the cards `conversation_id` waits on, oldest edge first."""
        async with self._read() as s:
            rows = await s.execute(
                select(_Blocker.blocker_id)
                .where(_Blocker.conversation_id == conversation_id)
                .order_by(_Blocker.created_at, _Blocker.blocker_id)
            )
            return list(rows.scalars())

    async def dependents(self, blocker_id: str) -> list[str]:
        """The keys of the cards waiting on `blocker_id`."""
        async with self._read() as s:
            rows = await s.execute(
                select(_Blocker.conversation_id).where(_Blocker.blocker_id == blocker_id).order_by(_Blocker.conversation_id)
            )
            return list(rows.scalars())

    async def set_blockers(self, conversation_id: str, blocker_ids: list[str], *, by: str) -> None:
        """Replace a card's blockers, keeping the edges that stay as they were."""
        async with self._session() as s, s.begin():
            want = list(dict.fromkeys(blocker_ids))
            have = set(
                (await s.execute(select(_Blocker.blocker_id).where(_Blocker.conversation_id == conversation_id))).scalars()
            )
            await s.execute(
                delete(_Blocker).where(
                    _Blocker.conversation_id == conversation_id, _Blocker.blocker_id.not_in(want)
                )
            )
            at = now_iso()
            for b in want:
                if b not in have:
                    s.add(_Blocker(conversation_id=conversation_id, blocker_id=b, created_by=by, created_at=at))

    async def tags(self, board_id: str) -> list[Tag]:
        """A board's tags in board order."""
        async with self._read() as s:
            rows = await s.execute(
                select(_Tag).where(_Tag.board_id == board_id).order_by(_Tag.position, _Tag.id)
            )
            return [_tag(r) for r in rows.scalars()]

    async def skills(self, board_id: str) -> list[Skill]:
        """A board's skills in board order."""
        async with self._read() as s:
            rows = await s.execute(
                select(_Skill).where(_Skill.board_id == board_id).order_by(_Skill.position, _Skill.id)
            )
            return [_skill(r) for r in rows.scalars()]

    async def card_tags(self, conversation_id: str) -> list[str]:
        """The ids of a card's tags, from any board."""
        async with self._read() as s:
            rows = await s.execute(select(_CardTag.tag_id).where(_CardTag.conversation_id == conversation_id))
            return list(rows.scalars())

    async def tag_boards(self, owner: str, tag_ids: list[str]) -> dict[str, str]:
        """Tag id -> board id, for those of `tag_ids` on `owner`'s boards."""
        async with self._read() as s:
            rows = await s.execute(
                select(_Tag.id, _Tag.board_id)
                .join(_Board, _Board.folder_id == _Tag.board_id)
                .where(_Tag.id.in_(tag_ids), _Board.owner == owner)
            )
            return {t: b for t, b in rows.tuples()}

    async def set_card_tags(
        self, conversation_id: str, tag_ids: list[str], *, board_id: str = "", create: list[Tag] | None = None
    ) -> list[Tag]:
        """Replace a card's tags, first adding `create` to `board_id`; tags from other boards are dropped too.

        The card gets `tag_ids` and then the new tags; returns the new tags with their ids.
        """
        async with self._session() as s, s.begin():
            made = [
                _Tag(id=str(uuid.uuid4()), board_id=board_id, name=t.name, color=t.color, position=t.position)
                for t in create or []
            ]
            s.add_all(made)
            await s.execute(delete(_CardTag).where(_CardTag.conversation_id == conversation_id))
            s.add_all(_CardTag(conversation_id=conversation_id, tag_id=t) for t in [*tag_ids, *(m.id for m in made)])
            return [_tag(m) for m in made]

    async def details(self, conversation_id: str) -> Details:
        """A card's description and priority; empty when none were set."""
        async with self._read() as s:
            row = await s.get(_Details, conversation_id)
            return _details(row) if row else Details()

    async def set_details(
        self, conversation_id: str, *, by: str, description: str | None = None, priority: int | None = None
    ) -> Details:
        """Change a card's description or priority; None keeps it."""
        async with self._session() as s, s.begin():
            row = await s.get(_Details, conversation_id)
            if row is None:
                row = _Details(conversation_id=conversation_id, description="", priority=0)
                s.add(row)
            if description is not None:
                row.description = description[:MAX_DESCRIPTION_CHARS]
            if priority is not None:
                row.priority = priority
            row.updated_by = by
            row.updated_at = now_iso()
            await s.flush()
            return _details(row)

    async def board_view(self, keys: list[str]) -> BoardView:
        """Card state for `keys`, one query per table."""
        out = BoardView()
        if not keys:
            return out
        async with self._read() as s:
            for row in (await s.execute(select(_Card).where(_Card.conversation_id.in_(keys)))).scalars():
                out.cards[row.conversation_id] = _card(row)
            tags = await s.execute(select(_CardTag.conversation_id, _CardTag.tag_id).where(_CardTag.conversation_id.in_(keys)))
            for key, tag in tags:
                out.tags.setdefault(key, []).append(tag)
            for row in (await s.execute(select(_Details).where(_Details.conversation_id.in_(keys)))).scalars():
                out.details[row.conversation_id] = _details(row)
            edges = await s.execute(
                select(_Blocker.conversation_id, _Blocker.blocker_id)
                .where(_Blocker.conversation_id.in_(keys))
                .order_by(_Blocker.created_at, _Blocker.blocker_id)
            )
            for key, blocker in edges:
                out.blockers.setdefault(key, []).append(blocker)
            pending = await s.execute(
                select(_GateResult.conversation_id, _GateResult.gate_id)
                .where(_GateResult.conversation_id.in_(keys), _GateResult.state == "pending")
            )
            for key, gate in pending:
                out.pending.setdefault(key, []).append(gate)
        return out


def _details(row: _Details) -> Details:
    return Details(
        description=row.description or "", priority=row.priority or 0, updated_by=row.updated_by, updated_at=row.updated_at
    )


def _gate(row: _Gate) -> Gate:
    return Gate(
        id=row.id, stage=row.stage_id, kind=row.kind, name=row.name, position=row.position,
        command=row.command or "", workdir=row.workdir or "", clean=bool(row.clean),
        timeout_seconds=row.timeout_seconds or 600,
    )


def _result(row: _GateResult) -> GateResult:
    return GateResult(
        gate=row.gate_id, state=row.state, detail=row.detail or "", commit=row.commit or "",
        updated_by=row.updated_by, updated_at=row.updated_at,
    )


def _skill(row: _Skill) -> Skill:
    return Skill(id=row.id, name=row.name, body=row.body, position=row.position)


def _tag(row: _Tag) -> Tag:
    return Tag(id=row.id, name=row.name, color=row.color, position=row.position)
