"""The search index and pending spawn requests, in this contrib's own `contrib_handoff` database.

The DDL lives in contrib/handoff/sql/schema.sql (Atlas owns it); this module never creates
tables. Search uses Postgres full-text search, with a LIKE fallback for the SQLite tests.
"""

from __future__ import annotations

import re
import time
import uuid
from dataclasses import dataclass

from sqlalchemy import BigInteger, Integer, String, Text, delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

_SNIPPET_CHARS = 240
# Candidate messages read per query, before grouping by conversation.
_CANDIDATES = 200


class _Base(DeclarativeBase):
    pass


class _Conversation(_Base):
    __tablename__ = "handoff_conversations"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(Text)
    owner: Mapped[str | None] = mapped_column(String, nullable=True)
    last_activity_at: Mapped[int] = mapped_column(BigInteger)


class _Message(_Base):
    __tablename__ = "handoff_messages"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    role: Mapped[str] = mapped_column(String)
    text: Mapped[str] = mapped_column(Text)


class _SpawnRequest(_Base):
    __tablename__ = "handoff_spawn_requests"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    conversation_id: Mapped[str] = mapped_column(String)
    owner: Mapped[str] = mapped_column(String)
    brief: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String)
    spawned_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger)
    decided_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


# Pending requests one conversation may hold at once.
MAX_PENDING = 3


class Refused(Exception):
    """A spawn request that cannot be made or answered, with the reason."""


class NotYours(Refused):
    pass


@dataclass(frozen=True)
class SpawnRequest:
    id: str
    conversation_id: str
    owner: str
    brief: str
    title: str
    model: str
    status: str
    spawned_id: str | None = None


def _request(row: _SpawnRequest) -> SpawnRequest:
    return SpawnRequest(
        row.id, row.conversation_id, row.owner, row.brief, row.title, row.model, row.status, row.spawned_id,
    )


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(frozen=True)
class Hit:
    conversation_id: str
    title: str
    owner: str | None
    last_activity_at: int
    snippet: str
    score: float


class HandoffStore:
    def __init__(self, config: StoreConfig) -> None:
        self._engine: AsyncEngine
        self._engine, self._session = open_sessions(config)

    async def indexed(self) -> dict[str, int]:
        """conversation id -> the activity time it was indexed at."""
        async with self._session() as s:
            rows = (await s.execute(select(_Conversation.conversation_id, _Conversation.last_activity_at))).all()
        return {cid: at for cid, at in rows}

    async def replace_conversation(
        self, conversation_id: str, *, title: str, owner: str | None, last_activity_at: int,
        messages: list[tuple[str, str]],
    ) -> None:
        """Swap in a conversation's current messages, as (role, text) in order."""
        async with self._session() as s, s.begin():
            await s.execute(delete(_Message).where(_Message.conversation_id == conversation_id))
            await s.merge(_Conversation(
                conversation_id=conversation_id, title=title, owner=owner, last_activity_at=last_activity_at,
            ))
            s.add_all(
                _Message(conversation_id=conversation_id, seq=i, role=role, text=body)
                for i, (role, body) in enumerate(messages)
            )

    async def remove_conversations(self, ids: list[str]) -> None:
        if not ids:
            return
        async with self._session() as s, s.begin():
            await s.execute(delete(_Message).where(_Message.conversation_id.in_(ids)))
            await s.execute(delete(_Conversation).where(_Conversation.conversation_id.in_(ids)))

    async def request_spawn(
        self, conversation_id: str, owner: str, *, brief: str, title: str, model: str,
    ) -> SpawnRequest:
        """A spawn waiting for the owner's approval; Refused past MAX_PENDING."""
        async with self._session() as s, s.begin():
            waiting = await s.scalar(select(func.count()).select_from(_SpawnRequest).where(
                _SpawnRequest.conversation_id == conversation_id, _SpawnRequest.status == "pending",
            ))
            if waiting >= MAX_PENDING:
                raise Refused(f"this conversation already has {waiting} handoffs waiting for approval")
            row = _SpawnRequest(
                id=str(uuid.uuid4()), conversation_id=conversation_id, owner=owner, brief=brief,
                title=title, model=model, status="pending", created_at=_now_ms(),
            )
            s.add(row)
        return _request(row)

    async def spawn_request(self, request_id: str) -> SpawnRequest | None:
        async with self._session() as s:
            row = await s.get(_SpawnRequest, request_id)
        return _request(row) if row else None

    async def pending_spawns(self, conversation_id: str) -> list[SpawnRequest]:
        q = (
            select(_SpawnRequest)
            .where(_SpawnRequest.conversation_id == conversation_id, _SpawnRequest.status == "pending")
            .order_by(_SpawnRequest.created_at)
        )
        async with self._session() as s:
            return [_request(r) for r in (await s.scalars(q)).all()]

    async def decide_spawn(self, request_id: str, approver: str, status: str) -> SpawnRequest:
        """Move the owner's pending request to `status`, exactly once."""
        async with self._session() as s, s.begin():
            row = await s.get(_SpawnRequest, request_id)
            if row is None or row.owner != approver:
                raise NotYours("no such handoff request for this user")
            claimed = await s.execute(
                update(_SpawnRequest)
                .where(_SpawnRequest.id == request_id, _SpawnRequest.status == "pending")
                .values(status=status, decided_at=_now_ms())
                .execution_options(synchronize_session=False)
            )
            if claimed.rowcount != 1:
                raise Refused(f"this handoff request is already {row.status}")
            await s.refresh(row)
        return _request(row)

    async def record_spawn(self, request_id: str, *, spawned_id: str | None, status: str) -> None:
        """An approved request's outcome: the new conversation, or failed."""
        async with self._session() as s, s.begin():
            await s.execute(
                update(_SpawnRequest).where(_SpawnRequest.id == request_id).values(status=status, spawned_id=spawned_id)
            )

    async def search(self, query: str, limit: int, *, exclude: set[str] = frozenset()) -> list[Hit]:
        """Best-matching conversations, one hit each, best first."""
        if self._engine.dialect.name == "postgresql":
            matches = await self._search_fts(query)
        else:
            matches = await self._search_like(query)
        best: dict[str, tuple[float, str]] = {}
        for cid, score, snippet in matches:
            if cid not in exclude and (cid not in best or score > best[cid][0]):
                best[cid] = (score, snippet)
        if not best:
            return []
        async with self._session() as s:
            convs = {
                c.conversation_id: c
                for c in (await s.execute(
                    select(_Conversation).where(_Conversation.conversation_id.in_(list(best)))
                )).scalars()
            }
        terms = _terms(query)
        hits = []
        for cid, (score, snippet) in best.items():
            conv = convs.get(cid)
            if conv is None:
                continue
            # A title match outranks a passing mention in one message.
            if terms and all(t in conv.title.lower() for t in terms):
                score += 1.0
            hits.append(Hit(cid, conv.title, conv.owner, conv.last_activity_at, snippet, round(score, 4)))
        hits.sort(key=lambda h: (h.score, h.last_activity_at), reverse=True)
        return hits[:limit]

    async def _search_fts(self, query: str) -> list[tuple[str, float, str]]:
        stmt = text(
            """
            SELECT m.conversation_id, ts_rank(to_tsvector('english', m.text), q) AS score,
                   ts_headline('english', m.text, q, 'MaxWords=35, MinWords=12') AS snippet
            FROM handoff_messages m, websearch_to_tsquery('english', :query) q
            WHERE to_tsvector('english', m.text) @@ q
            ORDER BY score DESC
            LIMIT :candidates
            """
        )
        async with self._session() as s:
            rows = (await s.execute(stmt, {"query": query, "candidates": _CANDIDATES})).all()
        return [(cid, float(score), snippet) for cid, score, snippet in rows]

    async def _search_like(self, query: str) -> list[tuple[str, float, str]]:
        terms = _terms(query)
        if not terms:
            return []
        stmt = select(_Message.conversation_id, _Message.text)
        for t in terms:
            stmt = stmt.where(func.lower(_Message.text).contains(t))
        async with self._session() as s:
            rows = (await s.execute(stmt.limit(_CANDIDATES))).all()
        return [(cid, float(sum(body.lower().count(t) for t in terms)), _snippet(body, terms[0])) for cid, body in rows]


def _terms(query: str) -> list[str]:
    return [t for t in re.findall(r"\w+", query.lower()) if len(t) > 1]


def _snippet(body: str, term: str) -> str:
    at = max(0, body.lower().find(term) - _SNIPPET_CHARS // 3)
    return body[at:at + _SNIPPET_CHARS].strip()
