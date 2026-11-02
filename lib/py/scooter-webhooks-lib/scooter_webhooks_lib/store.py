"""The conversation-mapping store: async engine, session, and query helpers.

Maps an external thread (a Slack thread, a GitHub PR, a Jira issue) to the
conversation it spawned. ``init_db()`` is called once at service startup with the
app's database settings, typed by the `DatabaseConfig` protocol.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncGenerator, Protocol, runtime_checkable

from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from . import resources
from .sender import Sender

# The ORM classes are generated from lib/sql/webhooks/schema.sql; the generator pluralizes names, aliased back to singular here.
from scooter_schema.webhooks import (
    ConversationMap,
    PendingMessages as PendingMessage,
    ResourceLinks as ResourceLink,
)

logger = logging.getLogger(__name__)
_C = {"component": "store"}


@runtime_checkable
class DatabaseConfig(Protocol):
    """What this store needs from the app's settings object: the DSN and an informational host label."""

    dsn: str
    db_host: str

PENDING_CONVERSATION_ID = "__pending__"
_PENDING_TIMEOUT_SECONDS = 120

_engine = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


async def init_db(settings: DatabaseConfig) -> None:
    """Initialize the async engine; tables are provisioned by the Atlas migrate job from lib/sql/webhooks/schema.sql, not here."""
    global _engine, _session_factory
    # pool_pre_ping recycles a connection the server closed underneath us, and pool_recycle retires one before common idle timeouts.
    _engine = create_async_engine(
        settings.dsn,
        echo=False,
        pool_pre_ping=True,
        pool_recycle=1800,
    )
    _session_factory = async_sessionmaker(_engine, expire_on_commit=False)
    logger.info("database initialized", extra={**_C, "db_host": settings.db_host})


async def close_db() -> None:
    """Dispose of the engine."""
    global _engine, _session_factory
    if _engine:
        await _engine.dispose()
    _engine = None
    _session_factory = None


@asynccontextmanager
async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Yield an async session with auto-commit on success."""
    assert _session_factory is not None, "Database not initialized. Call init_db() first."
    async with _session_factory() as session:
        async with session.begin():
            yield session


# ---------------------------------------------------------------------------
# Conversation map helpers
# ---------------------------------------------------------------------------


async def lookup_conversation(source: str, resource_type: str, resource_id: str) -> str | None:
    """The conversation for a resource, or None, clearing a pending entry older than _PENDING_TIMEOUT_SECONDS."""
    async with get_session() as session:
        row = (
            await session.execute(
                select(ConversationMap)
                .where(
                    ConversationMap.source == source,
                    ConversationMap.resource_type == resource_type,
                    ConversationMap.resource_id == resource_id,
                )
            )
        ).scalar_one_or_none()

        if row is None:
            return None

        if row.conversation_id == PENDING_CONVERSATION_ID:
            created = row.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            age = (datetime.now(timezone.utc) - created).total_seconds()
            if age > _PENDING_TIMEOUT_SECONDS:
                await session.execute(
                    delete(ConversationMap).where(
                        ConversationMap.source == source,
                        ConversationMap.resource_type == resource_type,
                        ConversationMap.resource_id == resource_id,
                    )
                )
                await session.execute(
                    delete(PendingMessage).where(
                        PendingMessage.source == source,
                        PendingMessage.resource_type == resource_type,
                        PendingMessage.resource_id == resource_id,
                    )
                )
                logger.warning(
                    "cleared stale pending conversation",
                    extra={
                        **_C,
                        "source": source,
                        "resource_type": resource_type,
                        "resource_id": resource_id,
                        "age_s": int(age),
                    },
                )
                return None

        return row.conversation_id


async def store_conversation(
    source: str, resource_type: str, resource_id: str, conversation_id: str
) -> None:
    """Upsert the mapping from an external resource to a conversation."""
    async with get_session() as session:
        existing = (
            await session.execute(
                select(ConversationMap).where(
                    ConversationMap.source == source,
                    ConversationMap.resource_type == resource_type,
                    ConversationMap.resource_id == resource_id,
                )
            )
        ).scalar_one_or_none()

        if existing:
            existing.conversation_id = conversation_id
        else:
            session.add(ConversationMap(
                source=source,
                resource_type=resource_type,
                resource_id=resource_id,
                conversation_id=conversation_id,
            ))

    logger.info(
        "stored mapping",
        extra={
            **_C,
            "source": source,
            "resource_type": resource_type,
            "resource_id": resource_id,
            "conversation_id": conversation_id,
        },
    )


async def store_slack_metadata(
    conversation_id: str, channel: str, message_ts: str
) -> None:
    """Store Slack channel and message timestamp for status updates."""
    async with get_session() as session:
        await session.execute(
            update(ConversationMap)
            .where(ConversationMap.conversation_id == conversation_id)
            .values(slack_channel=channel, slack_ts=message_ts)
        )


async def update_last_status(conversation_id: str, status: str) -> None:
    """Update the last known status for a conversation."""
    async with get_session() as session:
        await session.execute(
            update(ConversationMap)
            .where(ConversationMap.conversation_id == conversation_id)
            .values(last_status=status)
        )


async def get_active_conversations() -> list[dict]:
    """Get all conversations that have tracking metadata (note_id or slack_ts set)."""
    async with get_session() as session:
        rows = (
            await session.execute(
                select(ConversationMap).where(
                    (ConversationMap.note_id.is_not(None))
                    | (ConversationMap.slack_ts.is_not(None))
                )
            )
        ).scalars().all()

        return [
            {
                "conversation_id": r.conversation_id,
                "source": r.source,
                "resource_id": r.resource_id,
                "project_id": r.project_id,
                "noteable_type": r.noteable_type,
                "noteable_iid": r.noteable_iid,
                "note_id": r.note_id,
                "slack_channel": r.slack_channel,
                "slack_ts": r.slack_ts,
                "last_status": r.last_status,
            }
            for r in rows
        ]


# ---------------------------------------------------------------------------
# Resource link helpers
# ---------------------------------------------------------------------------


async def link_resource(
    conversation_id: str, source: str, resource_type: str, resource_id: str
) -> bool:
    """Link a resource to a conversation, storing the canonical shape and treating an existing row in any known shape as already linked; True if newly inserted."""
    rtype, rid = resources.canonical_link(source, resource_type, resource_id)
    async with get_session() as session:
        for vtype, vid in resources.link_variants(source, resource_type, resource_id):
            existing = (
                await session.execute(
                    select(ResourceLink).where(
                        ResourceLink.source == source,
                        ResourceLink.resource_type == vtype,
                        ResourceLink.resource_id == vid,
                    )
                )
            ).scalar_one_or_none()
            if existing:
                return False

        session.add(ResourceLink(
            conversation_id=conversation_id,
            source=source,
            resource_type=rtype,
            resource_id=rid,
            # A URL-shaped canonical id also fills the column the UI links and the agent-host derives a ref from.
            url=rid if rid.startswith(("http://", "https://")) else None,
        ))
        return True


async def get_conversation_for_resource(
    source: str, resource_type: str, resource_id: str
) -> str | None:
    """The conversation linked to a resource in any of its stored shapes (see resources.link_variants)."""
    async with get_session() as session:
        for vtype, vid in resources.link_variants(source, resource_type, resource_id):
            row = (
                await session.execute(
                    select(ResourceLink).where(
                        ResourceLink.source == source,
                        ResourceLink.resource_type == vtype,
                        ResourceLink.resource_id == vid,
                    )
                )
            ).scalar_one_or_none()
            if row:
                return row.conversation_id
        return None

async def resources_for_conversation(
    conversation_id: str, source: str | None = None, resource_type: str | None = None
) -> list[tuple[str, str, str]]:
    """Every (source, resource_type, resource_id) linked to a conversation, oldest first, with `resource_type` matched in its canonical spelling."""
    wanted_type = (
        resources.canonical_resource_type(source, resource_type)
        if source and resource_type
        else resource_type
    )
    async with get_session() as session:
        stmt = select(ResourceLink).where(ResourceLink.conversation_id == conversation_id)
        if source:
            stmt = stmt.where(ResourceLink.source == source)
        if wanted_type:
            stmt = stmt.where(ResourceLink.resource_type == wanted_type)
        rows = (await session.execute(stmt.order_by(ResourceLink.id.asc()))).scalars().all()
        return [(r.source, r.resource_type, r.resource_id) for r in rows]


# ---------------------------------------------------------------------------
# Pending message helpers
# ---------------------------------------------------------------------------


def is_pending(conversation_id: str | None) -> bool:
    """True if the conversation_id is the pending placeholder."""
    return conversation_id == PENDING_CONVERSATION_ID


async def store_pending_message(
    source: str, resource_type: str, resource_id: str, message: str, sender: Sender | None = None
) -> None:
    """Queue a message for a resource whose conversation is still being created."""
    async with get_session() as session:
        session.add(PendingMessage(
            source=source,
            resource_type=resource_type,
            resource_id=resource_id,
            message=message,
            sender=sender.to_payload() if sender is not None else None,
        ))
    logger.info(
        "queued pending message",
        extra={
            **_C,
            "source": source,
            "resource_type": resource_type,
            "resource_id": resource_id,
        },
    )


async def get_and_clear_pending_messages(
    source: str, resource_type: str, resource_id: str
) -> list[tuple[str, Sender | None]]:
    """Get and delete all pending messages for a resource, each with its sender."""
    async with get_session() as session:
        rows = (
            await session.execute(
                select(PendingMessage)
                .where(
                    PendingMessage.source == source,
                    PendingMessage.resource_type == resource_type,
                    PendingMessage.resource_id == resource_id,
                )
                .order_by(PendingMessage.id.asc())
            )
        ).scalars().all()

        messages = [(r.message, _stored_sender(r.sender)) for r in rows]

        if rows:
            await session.execute(
                delete(PendingMessage).where(
                    PendingMessage.source == source,
                    PendingMessage.resource_type == resource_type,
                    PendingMessage.resource_id == resource_id,
                )
            )

        return messages


def _stored_sender(data: dict | None) -> Sender | None:
    """A queued message's sender; an unreadable one is dropped, never guessed."""
    if not data:
        return None
    try:
        return Sender.from_payload(data)
    except (KeyError, ValueError):
        logger.warning("dropped unreadable pending sender", extra=_C)
        return None


async def clear_conversation(
    source: str, resource_type: str, resource_id: str
) -> None:
    """Remove a conversation mapping."""
    async with get_session() as session:
        await session.execute(
            delete(ConversationMap).where(
                ConversationMap.source == source,
                ConversationMap.resource_type == resource_type,
                ConversationMap.resource_id == resource_id,
            )
        )
    logger.info(
        "cleared conversation mapping",
        extra={
            **_C,
            "source": source,
            "resource_type": resource_type,
            "resource_id": resource_id,
        },
    )
