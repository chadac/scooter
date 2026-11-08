"""The search index, in this contrib's own `contrib_handoff` database.

The DDL lives in contrib/handoff/sql/schema.sql (Atlas owns it); this module never creates
tables. Search uses Postgres full-text search, with a LIKE fallback for the SQLite tests.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import BigInteger, Integer, String, Text, delete, func, select, text
from sqlalchemy.ext.asyncio import AsyncEngine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from scooter_broker_lib.store import StoreConfig, open_sessions

SHARED, PRIVATE = "shared", "private"
_SNIPPET_CHARS = 240
# Candidate messages read per query, before grouping by conversation.
_CANDIDATES = 200


class _Base(DeclarativeBase):
    pass


class _Conversation(_Base):
    __tablename__ = "handoff_conversations"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(Text)
    owner: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    visibility: Mapped[str] = mapped_column(String, default=SHARED)
    last_activity_at: Mapped[int] = mapped_column(BigInteger)


class _Message(_Base):
    __tablename__ = "handoff_messages"

    conversation_id: Mapped[str] = mapped_column(String, primary_key=True)
    seq: Mapped[int] = mapped_column(Integer, primary_key=True)
    role: Mapped[str] = mapped_column(String)
    text: Mapped[str] = mapped_column(Text)


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

    async def indexed(self, visibility: str, owner: str | None = None) -> dict[str, int]:
        """conversation id -> the activity time it was indexed at, for one visibility (and owner)."""
        stmt = select(_Conversation.conversation_id, _Conversation.last_activity_at).where(
            _Conversation.visibility == visibility
        )
        if owner is not None:
            stmt = stmt.where(_Conversation.owner == owner)
        async with self._session() as s:
            rows = (await s.execute(stmt)).all()
        return {cid: at for cid, at in rows}

    async def replace_conversation(
        self, conversation_id: str, *, title: str, owner: str | None, visibility: str, last_activity_at: int,
        messages: list[tuple[str, str]],
    ) -> None:
        """Swap in a conversation's current messages, as (role, text) in order."""
        async with self._session() as s, s.begin():
            await s.execute(delete(_Message).where(_Message.conversation_id == conversation_id))
            await s.merge(_Conversation(
                conversation_id=conversation_id, title=title, owner=owner, visibility=visibility,
                last_activity_at=last_activity_at,
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

    async def search(
        self, query: str, limit: int, *, owner: str | None = None, exclude: set[str] = frozenset(),
    ) -> list[Hit]:
        """Best-matching shared conversations, plus `owner`'s private ones, one hit each, best first."""
        if self._engine.dialect.name == "postgresql":
            matches = await self._search_fts(query, owner)
        else:
            matches = await self._search_like(query, owner)
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

    async def _search_fts(self, query: str, owner: str | None) -> list[tuple[str, float, str]]:
        stmt = text(
            """
            SELECT m.conversation_id, ts_rank(to_tsvector('english', m.text), q) AS score,
                   ts_headline('english', m.text, q, 'MaxWords=35, MinWords=12') AS snippet
            FROM handoff_messages m
            JOIN handoff_conversations c ON c.conversation_id = m.conversation_id,
                 websearch_to_tsquery('english', :query) q
            WHERE to_tsvector('english', m.text) @@ q
              AND (c.visibility = 'shared' OR c.owner = :owner)
            ORDER BY score DESC
            LIMIT :candidates
            """
        )
        async with self._session() as s:
            rows = (await s.execute(stmt, {"query": query, "owner": owner, "candidates": _CANDIDATES})).all()
        return [(cid, float(score), snippet) for cid, score, snippet in rows]

    async def _search_like(self, query: str, owner: str | None) -> list[tuple[str, float, str]]:
        terms = _terms(query)
        if not terms:
            return []
        stmt = (
            select(_Message.conversation_id, _Message.text)
            .join(_Conversation, _Conversation.conversation_id == _Message.conversation_id)
        )
        # `owner == None` would compile to IS NULL, so no owner means shared only.
        visible = _Conversation.visibility == SHARED
        stmt = stmt.where(visible | (_Conversation.owner == owner) if owner else visible)
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
