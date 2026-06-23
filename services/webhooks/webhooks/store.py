"""Async database session and query helpers.

All services share this module for PostgreSQL access. Each service
creates its own engine via ``init_db()`` at startup.
"""

import logging
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import AsyncGenerator

from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from .config import DatabaseSettings
from .models import Base, ConversationMap, CredentialScope, JiraTicket, PendingMessage, ResourceLink

logger = logging.getLogger(__name__)

PENDING_CONVERSATION_ID = "__pending__"
_PENDING_TIMEOUT_SECONDS = 120

_engine = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


async def init_db(settings: DatabaseSettings | None = None) -> None:
    """Initialize the async engine and create tables."""
    global _engine, _session_factory
    if settings is None:
        settings = DatabaseSettings()
    _engine = create_async_engine(settings.dsn, echo=False)
    _session_factory = async_sessionmaker(_engine, expire_on_commit=False)
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database initialized: %s", settings.db_host)


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
                    "Cleared stale pending conversation for %s/%s/%s (age=%ds)",
                    source, resource_type, resource_id, int(age),
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

    logger.info("Stored mapping: %s/%s/%s -> %s", source, resource_type, resource_id, conversation_id)


async def store_note_metadata(
    conversation_id: str,
    project_id: int,
    noteable_type: str,
    noteable_iid: int,
    note_id: int,
) -> None:
    """Store GitLab/GitHub comment metadata for status updates."""
    async with get_session() as session:
        await session.execute(
            update(ConversationMap)
            .where(ConversationMap.conversation_id == conversation_id)
            .values(
                project_id=project_id,
                noteable_type=noteable_type,
                noteable_iid=noteable_iid,
                note_id=note_id,
            )
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


async def store_jira_comment_id(
    conversation_id: str, comment_id: str
) -> None:
    """Store a Jira comment ID for status updates (reuses note_id column)."""
    async with get_session() as session:
        await session.execute(
            update(ConversationMap)
            .where(ConversationMap.conversation_id == conversation_id)
            .values(note_id=int(comment_id))
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
# Jira ticket helpers
# ---------------------------------------------------------------------------


async def link_jira_ticket(conversation_id: str, issue_key: str) -> bool:
    """Link a Jira ticket to a conversation. Returns True if newly inserted."""
    async with get_session() as session:
        existing = (
            await session.execute(
                select(JiraTicket).where(JiraTicket.issue_key == issue_key)
            )
        ).scalar_one_or_none()

        if existing:
            return False

        session.add(JiraTicket(conversation_id=conversation_id, issue_key=issue_key))

    # Also store in generic resource_links
    await link_resource(conversation_id, "jira", "issue", issue_key)
    return True


async def get_primary_jira_ticket(conversation_id: str) -> str | None:
    """Get the primary (first-created) Jira ticket for a conversation."""
    async with get_session() as session:
        row = (
            await session.execute(
                select(JiraTicket)
                .where(JiraTicket.conversation_id == conversation_id)
                .order_by(JiraTicket.id.asc())
                .limit(1)
            )
        ).scalar_one_or_none()
        return row.issue_key if row else None


async def get_jira_tickets(conversation_id: str) -> list[str]:
    """Get all Jira ticket keys linked to a conversation."""
    async with get_session() as session:
        rows = (
            await session.execute(
                select(JiraTicket)
                .where(JiraTicket.conversation_id == conversation_id)
                .order_by(JiraTicket.id.asc())
            )
        ).scalars().all()
        return [r.issue_key for r in rows]


async def get_conversation_for_jira_ticket(issue_key: str) -> str | None:
    """Look up the conversation linked to a Jira ticket."""
    async with get_session() as session:
        row = (
            await session.execute(
                select(JiraTicket).where(JiraTicket.issue_key == issue_key)
            )
        ).scalar_one_or_none()
        return row.conversation_id if row else None


# ---------------------------------------------------------------------------
# Resource link helpers
# ---------------------------------------------------------------------------


async def link_resource(
    conversation_id: str, source: str, resource_type: str, resource_id: str
) -> bool:
    """Link a resource to a conversation. Returns True if newly inserted."""
    async with get_session() as session:
        existing = (
            await session.execute(
                select(ResourceLink).where(
                    ResourceLink.source == source,
                    ResourceLink.resource_type == resource_type,
                    ResourceLink.resource_id == resource_id,
                )
            )
        ).scalar_one_or_none()

        if existing:
            return False

        session.add(ResourceLink(
            conversation_id=conversation_id,
            source=source,
            resource_type=resource_type,
            resource_id=resource_id,
        ))
        return True


async def get_conversation_for_resource(
    source: str, resource_type: str, resource_id: str
) -> str | None:
    """Look up the conversation linked to a resource."""
    async with get_session() as session:
        row = (
            await session.execute(
                select(ResourceLink).where(
                    ResourceLink.source == source,
                    ResourceLink.resource_type == resource_type,
                    ResourceLink.resource_id == resource_id,
                )
            )
        ).scalar_one_or_none()
        return row.conversation_id if row else None


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
    logger.info("Queued pending message for %s/%s/%s", source, resource_type, resource_id)


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
    logger.info("Cleared conversation mapping for %s/%s/%s", source, resource_type, resource_id)


# ---------------------------------------------------------------------------
# Credential scope helpers (used by broker)
# ---------------------------------------------------------------------------


async def add_credential_scope(
    conversation_id: str, provider: str, scope: str
) -> bool:
    """Grant a conversation access to a credential scope. Returns True if new."""
    async with get_session() as session:
        existing = (
            await session.execute(
                select(CredentialScope).where(
                    CredentialScope.conversation_id == conversation_id,
                    CredentialScope.provider == provider,
                    CredentialScope.scope == scope,
                )
            )
        ).scalar_one_or_none()

        if existing:
            return False

        session.add(CredentialScope(
            conversation_id=conversation_id,
            provider=provider,
            scope=scope,
        ))
        return True


async def get_credential_scopes(
    conversation_id: str, provider: str
) -> list[str]:
    """Get all scopes a conversation has for a provider."""
    async with get_session() as session:
        rows = (
            await session.execute(
                select(CredentialScope).where(
                    CredentialScope.conversation_id == conversation_id,
                    CredentialScope.provider == provider,
                )
            )
        ).scalars().all()
        return [r.scope for r in rows]
