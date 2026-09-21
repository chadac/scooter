"""The conversation-mapping store — async engine, session, and query helpers.

Maps an external thread (a Slack thread, a GitHub PR, a Jira issue) to the
conversation it spawned, which is the state every handler needs and none of them
should reimplement. ``init_db()`` is called once at service startup.

CONFIG STAYS IN THE APP. This module takes its database settings as an ARGUMENT
typed by the `DatabaseConfig` protocol below, rather than importing the webhooks
app's `config.DatabaseSettings`. That import is the only thing that stood between
this module and the lib, and a protocol removes it without dragging a settings
file across the boundary — the arrangement agreed on PR #567.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncGenerator, Protocol, runtime_checkable

from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from . import resources

# Models are the generated, single-source-of-truth ORM classes for the webhooks
# database (lib/sql/webhooks/schema.sql -> scooter_schema). The generator pluralizes
# class names; alias to this store's long-standing singular names so the query
# helpers below are unchanged. Why: PR #412.
from scooter_schema.webhooks import (
    ConversationMap,
    PendingMessages as PendingMessage,
    ResourceLinks as ResourceLink,
)

logger = logging.getLogger(__name__)
_C = {"component": "store"}


@runtime_checkable
class DatabaseConfig(Protocol):
    """What this store needs from whatever settings object the app hands it.

    Two fields, both already on the app's `DatabaseSettings`: the DSN to connect
    with, and a host label that is informational (it only ever reaches a log
    field). Assembling the DSN — from components, from a secretKeyRef password —
    stays the app's business.
    """

    dsn: str
    db_host: str

PENDING_CONVERSATION_ID = "__pending__"
_PENDING_TIMEOUT_SECONDS = 120

_engine = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


async def init_db(settings: DatabaseConfig) -> None:
    """Initialize the async engine.

    Tables are NOT created here: they are provisioned by the declarative schema +
    Atlas migrate job (lib/sql/webhooks/schema.sql). See PR #412.

    `settings` is REQUIRED. It used to default to constructing the app's
    DatabaseSettings, which meant a caller who forgot to pass one silently got a
    second, independently env-read config — and on a misread env, a SQLite file
    in /tmp instead of the durable Postgres store, with no error anywhere.
    """
    global _engine, _session_factory
    # pool_pre_ping: emit a lightweight liveness check when a connection is checked
    # out of the pool and RECYCLE it if the server (or an idle-timeout / proxy /
    # failover) has closed it underneath us — instead of handing out a dead
    # connection and 500ing the request with asyncpg "connection is closed" on the
    # next transaction start (observed on POST /webhooks/slack). pool_recycle caps a
    # connection's lifetime below common idle-timeout windows so stale ones are
    # retired proactively, not just reactively.
    _engine = create_async_engine(
        settings.dsn,
        echo=False,
        pool_pre_ping=True,
        pool_recycle=1800,  # recycle connections older than 30 min
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
    """Look up an existing conversation for the given resource.

    Auto-clears stuck pending entries older than _PENDING_TIMEOUT_SECONDS.
    Returns conversation_id or None.
    """
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
    """Store (upsert) a mapping from an external resource to an OpenHands conversation."""
    async with get_session() as session:
        # Try to find existing
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
    """Link a resource to a conversation. Returns True if newly inserted.

    Normalises rather than trusting the caller: the row is stored in the canonical
    shape, and an existing row in ANY known shape counts as already-linked. Without
    this, the same PR arriving as ("pull_request", "o/r#7") and ("pr", "<html_url>")
    produced two rows the other writer could never find. Why: issue #563.
    """
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
            # When the canonical id IS the resource's URL, store it in the url column
            # too: that is the column the UI links and agent-host derives a ref from.
            url=rid if rid.startswith(("http://", "https://")) else None,
        ))
        return True


async def get_conversation_for_resource(
    source: str, resource_type: str, resource_id: str
) -> str | None:
    """Look up the conversation linked to a resource, in any shape it may be stored
    in (see resources.link_variants) — the caller's own shape is tried first."""
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
    """Every resource linked to a conversation, oldest FIRST.

    The reverse of `get_conversation_for_resource`, and the generic form of the
    per-provider "which tickets does this conversation have" helpers. Returns
    (source, resource_type, resource_id) in insertion order, so the caller's
    "primary" resource is simply the first one.

    `resource_type` is matched against the CANONICAL spelling, because that is what
    link_resource stores -- asking for "ticket" finds rows written as "issue".
    Why: PR #581.
    """
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
    """Check if a conversation_id is a pending placeholder."""
    return conversation_id == PENDING_CONVERSATION_ID


async def store_pending_message(
    source: str, resource_type: str, resource_id: str, message: str
) -> None:
    """Queue a message for a resource whose conversation is still being created."""
    async with get_session() as session:
        session.add(PendingMessage(
            source=source,
            resource_type=resource_type,
            resource_id=resource_id,
            message=message,
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
) -> list[str]:
    """Get and delete all pending messages for a resource."""
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

        messages = [r.message for r in rows]

        if rows:
            await session.execute(
                delete(PendingMessage).where(
                    PendingMessage.source == source,
                    PendingMessage.resource_type == resource_type,
                    PendingMessage.resource_id == resource_id,
                )
            )

        return messages


async def clear_conversation(
    source: str, resource_type: str, resource_id: str
) -> None:
    """Remove a conversation mapping (e.g. to clear a pending marker on failure)."""
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
