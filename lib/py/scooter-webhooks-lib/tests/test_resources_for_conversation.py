"""The reverse lookup: which resources does this conversation have?

`get_conversation_for_resource` answered one direction; the other was only
available as per-provider helpers (`get_jira_tickets`, `get_primary_jira_ticket`)
reading a provider-specific table. This is the generic form, so a contrib needs no
table of its own to answer "the tickets on this conversation". Why: PR #581.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import pytest

from sqlalchemy import event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles

from scooter_schema.webhooks import Base as SchemaBase


@compiles(JSONB, "sqlite")
def _jsonb_as_json_on_sqlite(type_, compiler, **kw):  # pragma: no cover - DDL shim
    """resource_links.ref is JSONB (postgres). sqlite has no JSONB, and this test
    only needs the column to exist, not its json operators."""
    return "JSON"

from scooter_webhooks_lib import resources, store
from scooter_webhooks_lib.resources import ResourceShapes, register_resource_shapes


@dataclass
class _Config:
    dsn: str = "sqlite+aiosqlite:///:memory:"
    db_host: str = "local"


@pytest.fixture(autouse=True)
async def db():
    await store.init_db(_Config())
    # The first store test to run against a REAL table rather than a patched `db`:
    # the DDL comes from the generated ORM, so a column this query relies on cannot
    # drift away from lib/sql without failing here. Only resource_links is created —
    # the rest of the schema has postgres-only DDL (a lower(email) functional index)
    # that sqlite cannot render.
    # sqlite has no now(); resource_links.created_at defaults to it (postgres).
    @event.listens_for(store._engine.sync_engine, "connect")
    def _register_now(dbapi_conn, _record):  # pragma: no cover - DDL shim
        dbapi_conn.create_function(
            "now", 0, lambda: datetime.now(timezone.utc).isoformat(sep=" ")
        )

    async with store._engine.begin() as conn:
        await conn.run_sync(
            SchemaBase.metadata.create_all, tables=[store.ResourceLink.__table__]
        )
    saved = dict(resources._shapes)
    register_resource_shapes(
        "jira", ResourceShapes(type_aliases={"ticket": "issue", "issue": "issue"})
    )
    yield
    resources._shapes.clear()
    resources._shapes.update(saved)
    await store.close_db()


async def test_it_returns_nothing_for_an_unlinked_conversation():
    assert await store.resources_for_conversation("conv-none") == []


async def test_it_returns_every_resource_oldest_first():
    # Insertion order is the contract: "the primary ticket" is just the first row,
    # which is what the per-provider helper meant by first-created.
    await store.link_resource("conv-1", "jira", "issue", "ENG-1")
    await store.link_resource("conv-1", "jira", "issue", "ENG-2")
    await store.link_resource("conv-1", "github", "pr", "acme/app#4")

    assert await store.resources_for_conversation("conv-1") == [
        ("jira", "issue", "ENG-1"),
        ("jira", "issue", "ENG-2"),
        # Stored as written: only jira shapes are registered here, so github gets the
        # unregistered-source behavior from #576 — exact match, nothing invented.
        ("github", "pr", "acme/app#4"),
    ]


async def test_it_filters_by_source_and_type():
    await store.link_resource("conv-1", "jira", "issue", "ENG-1")
    await store.link_resource("conv-1", "github", "pr", "acme/app#4")

    assert await store.resources_for_conversation("conv-1", source="jira") == [
        ("jira", "issue", "ENG-1"),
    ]
    assert await store.resources_for_conversation(
        "conv-1", source="jira", resource_type="issue"
    ) == [("jira", "issue", "ENG-1")]


async def test_the_type_filter_is_canonicalised():
    # Asking for "ticket" must find a row stored as "issue" — otherwise every caller
    # has to know which spelling the writer happened to use, which is issue #563 in
    # miniature.
    await store.link_resource("conv-1", "jira", "ticket", "ENG-1")

    assert await store.resources_for_conversation(
        "conv-1", source="jira", resource_type="ticket"
    ) == [("jira", "issue", "ENG-1")]


async def test_conversations_do_not_bleed_into_each_other():
    await store.link_resource("conv-1", "jira", "issue", "ENG-1")
    await store.link_resource("conv-2", "jira", "issue", "ENG-2")

    assert await store.resources_for_conversation("conv-2") == [("jira", "issue", "ENG-2")]
