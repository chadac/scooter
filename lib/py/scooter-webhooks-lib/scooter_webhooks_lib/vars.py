"""Hidden per-conversation variables: service state the agent and user never see.

A small key/value store on the ``conversation_vars`` table, scoped to one
conversation and namespaced by the contrib that owns the keys. Per-resource
state goes in the key (``conflict_head:owner/repo#12``). agent-host deletes a
conversation's rows when it removes the conversation, so nothing here expires.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.dialects import postgresql, sqlite

from scooter_schema.webhooks import ConversationVars as ConversationVar

from .store import get_session

# Flags and SHAs, not blobs.
MAX_VALUE_BYTES = 4096


class ConversationVars:
    """One conversation's hidden variables in one namespace (by convention, the contrib's name)."""

    def __init__(self, conversation_id: str, namespace: str):
        if not conversation_id:
            raise ValueError("conversation_id must be non-empty")
        if not namespace:
            raise ValueError("namespace must be non-empty")
        self.conversation_id = conversation_id
        self.namespace = namespace

    async def get(self, key: str) -> Any | None:
        """The stored JSON value, or None when the key is unset."""
        async with get_session() as session:
            return (
                await session.execute(select(ConversationVar.value).where(*self._match(key)))
            ).scalar_one_or_none()

    async def set(self, key: str, value: Any) -> None:
        """Store `value` under `key`, replacing any earlier value."""
        async with get_session() as session:
            await session.execute(self._upsert(session, key, value))

    async def delete(self, key: str) -> None:
        """Unset `key`; a missing key is not an error."""
        async with get_session() as session:
            await session.execute(delete(ConversationVar).where(*self._match(key)))

    async def claim(self, key: str, value: Any) -> bool:
        """Store `value`; True only for the one caller whose write changed it.

        A single upsert, so replicas racing on the same value need no lock:
        Postgres serializes them and only the first sees its row come back.
        """
        async with get_session() as session:
            stmt = self._upsert(session, key, value, only_if_changed=True)
            return (await session.execute(stmt.returning(ConversationVar.key))).first() is not None

    def _match(self, key: str):
        return (
            ConversationVar.conversation_id == self.conversation_id,
            ConversationVar.namespace == self.namespace,
            ConversationVar.key == _checked_key(key),
        )

    # The unit tests run on sqlite, which has its own ON CONFLICT construct.
    _INSERTS = {"postgresql": postgresql.insert, "sqlite": sqlite.insert}

    def _upsert(self, session, key: str, value: Any, only_if_changed: bool = False):
        stmt = self._INSERTS[session.bind.dialect.name](ConversationVar).values(
            conversation_id=self.conversation_id,
            namespace=self.namespace,
            key=_checked_key(key),
            value=_checked_value(value),
        )
        return stmt.on_conflict_do_update(
            index_elements=[
                ConversationVar.conversation_id,
                ConversationVar.namespace,
                ConversationVar.key,
            ],
            set_={"value": stmt.excluded.value, "updated_at": func.now()},
            where=ConversationVar.value.is_distinct_from(stmt.excluded.value) if only_if_changed else None,
        )


def _checked_key(key: str) -> str:
    if not key:
        raise ValueError("key must be non-empty")
    return key


def _checked_value(value: Any) -> Any:
    if value is None:
        raise ValueError("value must not be None; delete() the key instead")
    try:
        encoded = json.dumps(value)
    except (TypeError, ValueError) as e:
        raise ValueError(f"value is not JSON-serializable: {e}") from e
    if len(encoded.encode()) > MAX_VALUE_BYTES:
        raise ValueError(f"value is {len(encoded.encode())} bytes serialized; the limit is {MAX_VALUE_BYTES}")
    return value
