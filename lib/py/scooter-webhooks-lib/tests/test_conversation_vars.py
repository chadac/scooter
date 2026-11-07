"""Hidden per-conversation variables: get/set/delete and the once-per-value claim."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

import pytest

from sqlalchemy import event
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.ext.compiler import compiles

from scooter_schema.webhooks import Base as SchemaBase, ConversationVars as ConversationVar

from scooter_webhooks_lib import store
from scooter_webhooks_lib.vars import MAX_VALUE_BYTES, ConversationVars


@compiles(JSONB, "sqlite")
def _jsonb_as_json_on_sqlite(type_, compiler, **kw):  # pragma: no cover - DDL shim
    """sqlite has no JSONB."""
    return "JSON"


@dataclass
class _Config:
    dsn: str = "sqlite+aiosqlite:///:memory:"
    db_host: str = "local"


@pytest.fixture(autouse=True)
async def db():
    await store.init_db(_Config())

    # sqlite has no now(), which updated_at defaults to.
    @event.listens_for(store._engine.sync_engine, "connect")
    def _register_now(dbapi_conn, _record):  # pragma: no cover - DDL shim
        dbapi_conn.create_function(
            "now", 0, lambda: datetime.now(timezone.utc).isoformat(sep=" ")
        )

    async with store._engine.begin() as conn:
        await conn.run_sync(SchemaBase.metadata.create_all, tables=[ConversationVar.__table__])
    yield
    await store.close_db()


async def test_an_unset_key_reads_as_None():
    assert await ConversationVars("c1", "github").get("k") is None


async def test_set_then_get_round_trips_JSON():
    v = ConversationVars("c1", "github")
    await v.set("k", {"sha": "abc", "n": 1})
    assert await v.get("k") == {"sha": "abc", "n": 1}
    await v.set("k", "replaced")
    assert await v.get("k") == "replaced"


async def test_delete_unsets_and_tolerates_a_missing_key():
    v = ConversationVars("c1", "github")
    await v.set("k", 1)
    await v.delete("k")
    await v.delete("k")
    assert await v.get("k") is None


async def test_conversations_and_namespaces_are_separate():
    await ConversationVars("c1", "github").set("k", "a")
    assert await ConversationVars("c2", "github").get("k") is None
    assert await ConversationVars("c1", "gitlab").get("k") is None


async def test_claim_wins_once_per_value():
    v = ConversationVars("c1", "github")
    assert await v.claim("conflict_head:o/r#1", "abc") is True
    assert await v.claim("conflict_head:o/r#1", "abc") is False
    assert await v.claim("conflict_head:o/r#1", "def") is True
    assert await v.claim("conflict_head:o/r#1", "def") is False
    assert await v.get("conflict_head:o/r#1") == "def"


async def test_claim_after_set_of_the_same_value_loses():
    v = ConversationVars("c1", "github")
    await v.set("k", "abc")
    assert await v.claim("k", "abc") is False


@pytest.mark.parametrize(
    "conversation_id, namespace",
    [("", "github"), ("c1", "")],
)
def test_conversation_and_namespace_are_required(conversation_id, namespace):
    with pytest.raises(ValueError):
        ConversationVars(conversation_id, namespace)


@pytest.mark.parametrize(
    "key, value",
    [
        ("", 1),
        ("k", None),
        ("k", object()),
        ("k", "x" * MAX_VALUE_BYTES),
    ],
)
async def test_bad_keys_and_values_are_rejected(key, value):
    with pytest.raises(ValueError):
        await ConversationVars("c1", "github").set(key, value)
