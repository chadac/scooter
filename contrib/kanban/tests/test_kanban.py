"""kanban's store, routes and agent tools on in-memory SQLite."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_kanban import mcp_tools
from scooter_contrib_kanban.config import DEFAULT_COLUMNS, parse_columns
from scooter_contrib_kanban.store import KanbanStore, _Base
from scooter_contrib_kanban.transport import Kanban, is_stale

COLUMNS = parse_columns(DEFAULT_COLUMNS)
NOW = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
async def store():
    s = KanbanStore(sqlite_config())
    await create_schema(s, _Base)
    return s


@pytest.fixture
def app(store):
    transport = Kanban(store=store, columns=COLUMNS, stale_after=timedelta(minutes=30), now=lambda: NOW)
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    provider = Provider(name="kanban", transports=[transport], enabled=True)
    a.include_router(transport.routes(provider, authed), prefix="/kanban")
    a.state.caller = caller
    return a


def as_(app, *, conversation: str = "", user: str | None = None) -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id=conversation, namespace="ns", service_account="sa", relayed_user=user
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


def _ctx(conversation_id: str = "conv-1") -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id=conversation_id, namespace="ns", service_account="sa"),
        provider=Provider(name="kanban", transports=[]),
        upstream=None,  # type: ignore[arg-type]
        links=None,  # type: ignore[arg-type]
    )


# --- columns -------------------------------------------------------------------

def test_parse_columns_falls_back_on_garbage():
    assert [c.id for c in parse_columns("not json")] == ["design", "in-progress", "review", "done"]
    assert [c.id for c in parse_columns("[]")] == ["design", "in-progress", "review", "done"]
    assert [c.id for c in parse_columns('[{"id":"todo","label":"To do"}]')] == ["todo"]


# --- staleness -------------------------------------------------------------------

async def test_a_card_is_stale_when_unset_or_old(store):
    assert is_stale(None, timedelta(minutes=30), NOW)
    fresh = await store.put("c", column="design", by="agent", now=(NOW - timedelta(minutes=5)).isoformat())
    assert not is_stale(fresh, timedelta(minutes=30), NOW)
    old = await store.put("c", column="design", by="agent", now=(NOW - timedelta(hours=2)).isoformat())
    assert is_stale(old, timedelta(minutes=30), NOW)


# --- store -------------------------------------------------------------------------

async def test_put_keeps_the_note_unless_given(store):
    await store.put("c", column="design", by="agent", note="drafting", position=3.0)
    card = await store.put("c", column="design", by="user")
    assert (card.note, card.position, card.updated_by) == ("drafting", 3.0, "user")


async def test_a_card_entering_a_column_lands_at_its_top(store):
    await store.put("a", column="review", by="user", position=-2.0)
    await store.put("b", column="design", by="agent")
    card = await store.put("b", column="review", by="agent")
    assert (card.column, card.position) == ("review", -3.0)
    assert (await store.put("c", column="done", by="agent")).position == 0.0


async def test_a_reorder_keeps_who_updated_the_card_and_when(store):
    await store.put("c", column="design", by="agent", note="drafting", now="2026-01-01T00:00:00+00:00")
    card = await store.put("c", column="design", by="user", position=5.0)
    assert (card.position, card.updated_by, card.updated_at) == (5.0, "agent", "2026-01-01T00:00:00+00:00")
    # A move to another column is the user's update.
    card = await store.put("c", column="review", by="user", position=1.0)
    assert (card.position, card.updated_by) == (1.0, "user")


# --- routes ------------------------------------------------------------------------

async def test_the_sandbox_reads_its_own_card(app):
    async with as_(app, conversation="conv-1") as c:
        r = await c.get("/kanban/card")
    assert r.status_code == 200
    body = r.json()
    assert body["card"] is None and body["column"] == "design" and body["stale"] is True and body["board"] is False
    assert [col["id"] for col in body["columns"]] == ["design", "in-progress", "review", "done"]


async def test_the_card_route_needs_a_conversation(app):
    async with as_(app) as c:
        assert (await c.get("/kanban/card")).status_code == 403


async def test_the_board_routes_need_a_relayed_user(app):
    async with as_(app, conversation="conv-1") as c:
        assert (await c.get("/kanban/user/boards")).status_code == 403
        assert (await c.put("/kanban/conversation/conv-1/card", json={"column": "review"})).status_code == 403


async def test_the_user_moves_a_card_and_the_agent_sees_it(app):
    async with as_(app, user="alice") as c:
        r = await c.put("/kanban/conversation/conv-1/card", json={"column": "review", "position": 1.5})
        assert r.status_code == 200
        assert r.json()["card"]["updated_by"] == "user"
        assert (await c.get("/kanban/user/boards")).json()["columns"][0] == {"id": "design", "label": "Design"}
    async with as_(app, conversation="conv-1") as c:
        body = (await c.get("/kanban/card")).json()
    assert body["column"] == "review" and body["card"]["position"] == 1.5 and body["stale"] is False


@pytest.mark.parametrize("payload", [{"column": "nope"}, {"column": "review", "position": "x"}, {"column": "review", "position": True}])
async def test_a_bad_move_is_refused(app, payload):
    async with as_(app, user="alice") as c:
        assert (await c.put("/kanban/conversation/conv-1/card", json=payload)).status_code == 400


# --- tools -------------------------------------------------------------------------

async def test_the_agent_sets_and_reads_its_status(store):
    mcp_tools.configure(store, COLUMNS, timedelta(minutes=30))
    out = await mcp_tools.kanban_set_status(column="in-progress", note="  building the board  ", ctx=_ctx())
    assert not out.is_error and "`in-progress`" in out.text
    card = await store.card("conv-1")
    assert (card.column, card.note, card.updated_by) == ("in-progress", "building the board", "agent")
    got = await mcp_tools.kanban_get_status(ctx=_ctx())
    assert '"building the board"' in got.text and "`review` (Review)" in got.text


async def test_the_agent_cannot_pick_an_unknown_column(store):
    mcp_tools.configure(store, COLUMNS, timedelta(minutes=30))
    out = await mcp_tools.kanban_set_status(column="backlog", ctx=_ctx())
    assert out.is_error and "not a column" in out.text
    assert await store.card("conv-1") is None


async def test_the_agent_moves_only_its_own_card(store):
    mcp_tools.configure(store, COLUMNS, timedelta(minutes=30))
    await mcp_tools.kanban_set_status(column="done", ctx=_ctx("conv-a"))
    assert await store.card("conv-b") is None


# --- boards ------------------------------------------------------------------------

async def test_a_user_opts_folders_in_and_out_and_sees_only_their_own(app):
    async with as_(app, user="alice") as c:
        assert (await c.put("/kanban/user/boards/f-1")).json()["boards"] == ["f-1"]
        assert (await c.put("/kanban/user/boards/f-1")).json()["boards"] == ["f-1"]
    async with as_(app, user="bob") as c:
        assert (await c.get("/kanban/user/boards")).json()["boards"] == []
        # Bob can't opt out Alice's board.
        await c.delete("/kanban/user/boards/f-1")
    async with as_(app, user="alice") as c:
        assert (await c.get("/kanban/user/boards")).json()["boards"] == ["f-1"]
        assert (await c.delete("/kanban/user/boards/f-1")).json()["boards"] == []


async def test_a_bad_folder_id_is_refused(app):
    async with as_(app, user="alice") as c:
        assert (await c.put("/kanban/user/boards/-leading-dash")).status_code == 400
        assert (await c.put("/kanban/user/boards/" + "x" * 65)).status_code == 400
        # A folder service may pick its own ids.
        assert (await c.put("/kanban/user/boards/e2e-design")).status_code == 200
    async with as_(app, conversation="conv-1") as c:
        assert (await c.get("/kanban/card", params={"folder": "../x"})).status_code == 400


async def test_the_hooks_learn_whether_the_folder_is_a_board(app):
    async with as_(app, user="alice") as c:
        await c.put("/kanban/user/boards/f-1")
    async with as_(app, conversation="conv-1") as c:
        assert (await c.get("/kanban/card", params={"folder": "f-1"})).json()["board"] is True
        assert (await c.get("/kanban/card", params={"folder": "f-2"})).json()["board"] is False
