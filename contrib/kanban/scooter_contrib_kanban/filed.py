"""Which conversations a user filed in given folders, read straight from agent_host."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from sqlalchemy import select

from scooter_broker_lib.store import StoreConfig, open_sessions
from scooter_schema.agent_host import Conversations, UserConversationMetadata

from .folders import Conversation
from .keys import sandbox_key


@dataclass(frozen=True)
class Filed:
    conversation: Conversation
    folder: str
    # A subagent's key is its root's, so it never answers for the key.
    subagent: bool = False


class Filings(Protocol):
    async def filed_in(self, owner: str, folders: list[str]) -> list[Filed]: ...


class AgentHostFilings:
    """One indexed join over the two agent_host tables granted to the broker."""

    def __init__(self, config: StoreConfig) -> None:
        self._engine, self._session = open_sessions(config)

    async def filed_in(self, owner: str, folders: list[str]) -> list[Filed]:
        c, m = Conversations, UserConversationMetadata
        q = (
            select(c.id, c.title, c.sandbox_ref, c.parent_id, m.folder_id)
            .join(m, m.conversation_id == c.id)
            .where(m.owner == owner, m.folder_id.in_(folders), c.owner == owner)
        )
        async with self._session() as s:
            rows = (await s.execute(q)).all()
        return [
            Filed(
                Conversation(id=r.id, owner=owner, title=r.title, key=sandbox_key(r.sandbox_ref or "")),
                r.folder_id,
                subagent=bool(r.parent_id),
            )
            for r in rows
        ]
