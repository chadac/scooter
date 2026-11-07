"""Card store, in this contrib's own `contrib_kanban` database.

The DDL lives in contrib/kanban/sql/schema.sql (Atlas owns it); this module never
creates tables. A card is keyed by the broker's conversation key, so the agent's
tools and the board's relay routes address the same row.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from sqlalchemy import Float, String, Text, delete, func, select
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

MAX_NOTE_CHARS = 280


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

    async def card(self, conversation_id: str) -> Card | None:
        async with self._session() as s:
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
        """The folder ids `owner` opted in as boards, oldest first."""
        async with self._session() as s:
            rows = await s.execute(
                select(_Board.folder_id).where(_Board.owner == owner).order_by(_Board.created_at)
            )
            return list(rows.scalars())

    async def is_board(self, folder_id: str) -> bool:
        async with self._session() as s:
            return await s.get(_Board, folder_id) is not None

    async def add_board(self, owner: str, folder_id: str) -> None:
        """Opt a folder in; a folder another user already opted in is left alone."""
        async with self._session() as s, s.begin():
            if await s.get(_Board, folder_id) is None:
                s.add(_Board(folder_id=folder_id, owner=owner, created_at=now_iso()))

    async def remove_board(self, owner: str, folder_id: str) -> bool:
        async with self._session() as s, s.begin():
            res = await s.execute(delete(_Board).where(_Board.folder_id == folder_id, _Board.owner == owner))
            return res.rowcount > 0
