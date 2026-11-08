"""kanban's store, routes and agent tools on in-memory SQLite, with a fake router."""

from __future__ import annotations

import json
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_kanban import mcp_tools
from scooter_contrib_kanban.boards import Boards, positions
from scooter_contrib_kanban.config import parse_stages
from scooter_contrib_kanban.folders import Conversation, FolderError, RouterFolders
from scooter_contrib_kanban.keys import CardKeys
from scooter_contrib_kanban.messages import AgentHostMessages
from scooter_contrib_kanban.store import KanbanStore, _Base
from scooter_contrib_kanban.transport import Kanban, is_stale

STAGES = ["Design", "In progress", "Review", "Done"]
NOW = datetime(2026, 11, 6, 12, 0, tzinfo=timezone.utc)


@dataclass
class FakeFolder:
    name: str
    parent: str
    position: float


class FakeFolders:
    """The router: each user's folders, conversations by broker key, and placements."""

    def __init__(self) -> None:
        self.by_owner: dict[str, dict[str, FakeFolder]] = {}
        self.conversations: dict[str, Conversation] = {}
        self.placements: dict[tuple[str, str], str] = {}
        self.next = 0
        # Change pushes, as (owner, conversation ids).
        self.pushed: list[tuple[str, list[str]]] = []
        self.push_error = False

    def names(self, owner: str, parent: str = "") -> list[str]:
        mine = self.by_owner.get(owner, {})
        return [f.name for f in sorted((f for f in mine.values() if f.parent == parent), key=lambda f: f.position)]

    def _get(self, owner: str, folder: str) -> FakeFolder:
        f = self.by_owner.get(owner, {}).get(folder)
        if f is None:
            raise FolderError(404, "not found")
        return f

    async def create(self, owner: str, name: str, parent: str = "") -> str:
        if parent:
            self._get(owner, parent)
        if name in self.names(owner, parent):
            raise FolderError(409, "you already have a folder with that name there")
        mine = self.by_owner.setdefault(owner, {})
        self.next += 1
        # One past the last sibling, as the router places a new folder.
        last = max((f.position for f in mine.values() if f.parent == parent), default=0.0)
        mine[f"f-{self.next}"] = FakeFolder(name, parent, last + 1)
        return f"f-{self.next}"

    async def update(self, owner: str, folder: str, *, name: str | None = None, position: float | None = None) -> None:
        f = self._get(owner, folder)
        f.name, f.position = name or f.name, f.position if position is None else position

    async def delete(self, owner: str, folder: str, *, subfolders: bool = False) -> None:
        f = self._get(owner, folder)
        mine = self.by_owner[owner]
        gone = {folder} | ({k for k, v in mine.items() if v.parent == folder} if subfolders else set())
        for k in gone:
            mine.pop(k)
        for at, placed in list(self.placements.items()):
            if placed in gone:
                if subfolders or not f.parent:
                    del self.placements[at]
                else:
                    self.placements[at] = f.parent

    async def conversation(self, key: str) -> Conversation | None:
        """By card key or conversation id, as the router answers for either."""
        for k, c in self.conversations.items():
            if key in (k, c.id):
                return replace(c, key=k)
        return None

    async def placement(self, owner: str, conversation: str) -> str | None:
        return self.placements.get((owner, conversation))

    async def filed(self, owner: str) -> dict[str, str]:
        return {c: f for (o, c), f in self.placements.items() if o == owner}

    async def file(self, owner: str, conversation: str, folder: str) -> None:
        self._get(owner, folder)
        self.placements[(owner, conversation)] = folder

    async def changed(self, owner: str, conversations: list[str]) -> None:
        if self.push_error:
            raise FolderError(502, "router unreachable")
        self.pushed.append((owner, conversations))


@pytest.fixture
async def store():
    s = KanbanStore(sqlite_config())
    await create_schema(s, _Base)
    return s


@pytest.fixture
def folders():
    return FakeFolders()


@pytest.fixture
def boards(store, folders):
    return Boards(store=store, folders=folders, default_stages=STAGES)


@pytest.fixture
def app(boards):
    transport = Kanban(boards=boards, stale_after=timedelta(minutes=30), now=lambda: NOW)
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


def _ctx(conversation_id: str = "thread-1") -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id=conversation_id, namespace="ns", service_account="sa"),
        provider=Provider(name="kanban", transports=[]),
        upstream=None,  # type: ignore[arg-type]
        links=None,  # type: ignore[arg-type]
    )


async def _board(app, owner: str = "alice", name: str = "Infra") -> dict:
    async with as_(app, user=owner) as c:
        r = await c.post("/kanban/user/boards", json={"name": name})
    assert r.status_code == 200, r.text
    return next(b for b in r.json()["boards"] if b["folder"] == r.json()["folder"])


def _stage(board: dict, label: str) -> str:
    return next(s["id"] for s in board["stages"] if s["label"] == label)


# --- stages ----------------------------------------------------------------------

def test_parse_stages_falls_back_on_garbage():
    assert parse_stages("not json") == STAGES
    assert parse_stages("[]") == STAGES
    assert parse_stages('["To do", " ", 3]') == ["To do"]


# --- staleness -------------------------------------------------------------------

async def test_a_card_is_stale_when_unset_or_old(store):
    assert is_stale(None, timedelta(minutes=30), NOW)
    fresh = await store.put("c", column="s", by="agent", now=(NOW - timedelta(minutes=5)).isoformat())
    assert not is_stale(fresh, timedelta(minutes=30), NOW)
    old = await store.put("c", column="s", by="agent", now=(NOW - timedelta(hours=2)).isoformat())
    assert is_stale(old, timedelta(minutes=30), NOW)


async def test_a_run_owes_a_status_until_the_agent_sets_one(store):
    run_start = NOW - timedelta(minutes=2)
    before = await store.put("c", column="design", by="agent", now=(NOW - timedelta(minutes=5)).isoformat())
    assert is_stale(before, timedelta(minutes=30), NOW, since=run_start)
    during = await store.put("c", column="design", by="agent", now=(NOW - timedelta(minutes=1)).isoformat())
    assert not is_stale(during, timedelta(minutes=30), NOW, since=run_start)


async def test_a_users_move_waits_for_the_agent_to_confirm_it(store):
    moved = await store.put("c", column="in-progress", by="user", now=NOW.isoformat())
    assert is_stale(moved, timedelta(minutes=30), NOW)
    assert is_stale(moved, timedelta(minutes=30), NOW, since=NOW - timedelta(minutes=1))


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
    card = await store.put("c", column="review", by="user", position=1.0)
    assert (card.position, card.updated_by) == (1.0, "user")


# --- boards ------------------------------------------------------------------------

async def test_a_new_board_is_a_folder_with_a_folder_per_stage(app, folders):
    board = await _board(app, name="  Infra ")
    assert folders.names("alice") == ["Infra"]
    assert folders.names("alice", board["folder"]) == STAGES
    assert [s["label"] for s in board["stages"]] == STAGES


async def test_a_board_is_renamed_and_deleted_with_its_stages(app, folders):
    board = await _board(app)
    async with as_(app, user="alice") as c:
        assert (await c.patch(f"/kanban/user/boards/{board['folder']}", json={"name": "Platform"})).status_code == 200
        assert folders.names("alice") == ["Platform"]
        assert (await c.delete(f"/kanban/user/boards/{board['folder']}")).json()["boards"] == []
    assert folders.by_owner["alice"] == {}


async def test_a_user_changes_only_their_own_boards(app, folders):
    board = await _board(app)
    b = board["folder"]
    async with as_(app, user="bob") as c:
        assert (await c.get("/kanban/user/boards")).json()["boards"] == []
        assert (await c.patch(f"/kanban/user/boards/{b}", json={"name": "Mine"})).status_code == 404
        assert (await c.delete(f"/kanban/user/boards/{b}")).status_code == 404
    assert folders.names("alice") == ["Infra"] and folders.names("alice", b) == STAGES


async def test_the_router_refusing_a_name_reaches_the_user(app):
    board = await _board(app)
    async with as_(app, user="alice") as c:
        r = await c.post("/kanban/user/boards", json={"name": "Infra"})
        assert r.status_code == 409 and "already" in r.json()["detail"]
        assert (await c.post("/kanban/user/boards", json={"name": " "})).status_code == 400
        r = await _save(c, board, [*_kept(board), {"name": "Review"}])
        assert r.status_code == 409
        assert [b["folder"] for b in (await c.get("/kanban/user/boards")).json()["boards"]] == [board["folder"]]


async def test_a_board_deleted_elsewhere_is_forgotten(app, folders):
    board = await _board(app)
    folders.by_owner["alice"].clear()
    async with as_(app, user="alice") as c:
        assert (await c.delete(f"/kanban/user/boards/{board['folder']}")).json()["boards"] == []


async def test_a_board_from_before_stages_gets_the_defaults(app, store, folders):
    old = await folders.create("alice", "Old")
    await store.add_board("alice", old)
    async with as_(app, user="alice") as c:
        listed = (await c.get("/kanban/user/boards")).json()["boards"]
    assert [s["label"] for s in listed[0]["stages"]] == STAGES
    assert folders.names("alice", old) == STAGES


async def test_a_bad_folder_id_is_refused(app):
    async with as_(app, user="alice") as c:
        assert (await c.delete("/kanban/user/boards/-leading-dash")).status_code == 400
        assert (await c.delete("/kanban/user/boards/" + "x" * 65)).status_code == 400
    async with as_(app, conversation="key-1") as c:
        assert (await c.get("/kanban/card", params={"folder": "../x"})).status_code == 400
        # A folder service may pick its own ids.
        assert (await c.get("/kanban/card", params={"folder": "e2e-design"})).status_code == 200


# --- customizing stages --------------------------------------------------------------

async def test_deleting_a_stage_moves_its_cards_to_the_first(app, folders):
    board = await _board(app)
    b, review = board["folder"], _stage(board, "Review")
    folders.placements[("alice", "conv-1")] = review
    async with as_(app, user="alice") as c:
        await _save(c, board, [s for s in _kept(board) if s["id"] != review])
    assert folders.placements[("alice", "conv-1")] == b
    async with as_(app, conversation="key-1") as c:
        assert (await c.get("/kanban/card", params={"folder": b})).json()["column"] == "Design"


def test_positions_keep_the_most_old_ones_in_order():
    assert positions([1.0, 2.0, 3.0]) == [1.0, 2.0, 3.0]
    # The last stage moved first: only it gets a new position.
    assert positions([4.0, 1.0, 2.0, 3.0]) == [0.0, 1.0, 2.0, 3.0]
    assert positions([1.0, None, 2.0, None]) == [1.0, 1.5, 2.0, 3.0]
    assert positions([None, None]) == [1.0, 2.0]
    assert positions([]) == []


def _kept(board: dict) -> list[dict]:
    """A board's stages, as a save that keeps them sends them."""
    return [{"id": x["id"], "name": x["label"]} for x in board["stages"]]


async def _save(c, board: dict, stages: list[dict], tags: list[dict] | None = None):
    return await c.put(f"/kanban/user/boards/{board['folder']}", json={"stages": stages, "tags": tags or []})


async def test_one_save_renames_reorders_adds_and_deletes_stages(app, folders):
    board = await _board(app)
    s = {x["label"]: x["id"] for x in board["stages"]}
    async with as_(app, user="alice") as c:
        r = await _save(c, board, [
            {"id": s["Review"], "name": "QA"},
            {"id": s["Design"], "name": "Design"},
            {"name": "Backlog"},
            {"id": s["Done"], "name": "Done"},
        ])
    assert r.status_code == 200, r.text
    assert [x["label"] for x in r.json()["board"]["stages"]] == ["QA", "Design", "Backlog", "Done"]
    assert folders.names("alice", board["folder"]) == ["QA", "Design", "Backlog", "Done"]
    async with as_(app, user="alice") as c:
        listed = (await c.get("/kanban/user/boards")).json()["boards"][0]
    assert listed == r.json()["board"]


async def test_a_save_only_calls_the_router_for_stages_that_changed(app, folders):
    board = await _board(app)
    calls: list[str] = []
    update = folders.update

    async def counted(owner, folder, **kw):
        calls.append(folder)
        await update(owner, folder, **kw)

    folders.update = counted
    stages = _kept(board)
    stages[1]["name"] = "Doing"
    async with as_(app, user="alice") as c:
        assert (await _save(c, board, stages)).status_code == 200
    assert calls == [stages[1]["id"]]


async def test_a_save_sets_the_board_s_tags_and_takes_deleted_ones_off_cards(app, store):
    board = await _board(app)
    ids = await _tags(app, board, "bug", "infra")
    stages = _kept(board)
    async with as_(app, user="alice") as c:
        await c.put("/kanban/conversation/key-1/card/tags", json={"tags": [ids["bug"], ids["infra"]]})
        r = await _save(c, board, stages, [
            {"name": "perf"},
            {"id": ids["infra"], "name": "Infra", "color": "blue"},
        ])
    assert r.status_code == 200, r.text
    tags = r.json()["board"]["tags"]
    assert [(t["name"], t["color"]) for t in tags] == [("perf", "gray"), ("Infra", "blue")]
    assert await store.card_tags("key-1") == [ids["infra"]]


async def test_a_bad_save_changes_nothing(app, folders):
    board = await _board(app)
    ids = await _tags(app, board, "bug")
    stages = _kept(board)
    other = await _board(app, name="Home")
    # Each also renames a stage, which must not happen either.
    renamed = [{**stages[0], "name": "Renamed"}, *stages[1:]]
    bad = [
        ([], []),
        ([*renamed, {"name": " "}], []),
        ([*renamed, {"id": other["stages"][0]["id"], "name": "X"}], []),
        ([*renamed, stages[1]], []),
        (renamed, [{"name": "a"}, {"name": "A"}]),
        (renamed, [{"name": "x" * 25}]),
        (renamed, [{"name": "a", "color": "pink"}]),
        (renamed, [{"name": f"t{i}"} for i in range(21)]),
        (renamed, [{"id": "nope", "name": "a"}]),
    ]
    async with as_(app, user="alice") as c:
        for st, tg in bad:
            r = await _save(c, board, st, tg)
            assert r.status_code in (400, 409), (st, tg, r.text)
        for body in [{}, {"stages": "x", "tags": []}, {"stages": [{"id": "a"}], "tags": []}]:
            assert (await c.put(f"/kanban/user/boards/{board['folder']}", json=body)).status_code == 400
        listed = (await c.get("/kanban/user/boards")).json()["boards"][0]
    assert [x["label"] for x in listed["stages"]] == STAGES
    assert [t["id"] for t in listed["tags"]] == [ids["bug"]]
    assert folders.names("alice", board["folder"]) == STAGES
    async with as_(app, user="bob") as c:
        assert (await _save(c, board, stages)).status_code == 404


async def test_a_save_the_router_partly_refuses_keeps_what_it_did(app, folders):
    board = await _board(app)
    stages = _kept(board)
    create = folders.create

    async def refuse(owner, name, parent=""):
        if name == "Nope":
            raise FolderError(503, "router down")
        return await create(owner, name, parent)

    folders.create = refuse
    async with as_(app, user="alice") as c:
        r = await _save(c, board, [{**stages[0], "name": "Plan"}, *stages[1:], {"name": "Nope"}, {"name": "Later"}])
        assert r.status_code == 502
        listed = (await c.get("/kanban/user/boards")).json()["boards"][0]
    assert [x["label"] for x in listed["stages"]] == ["Plan", *STAGES[1:], "Later"]
    assert folders.names("alice", board["folder"]) == ["Plan", *STAGES[1:], "Later"]


# --- the hooks' card ---------------------------------------------------------------

async def test_the_hooks_learn_the_card_s_stage_from_its_folder(app):
    board = await _board(app)
    async with as_(app, conversation="key-1") as c:
        r = (await c.get("/kanban/card", params={"folder": _stage(board, "Review")})).json()
        assert r["board"] is True and r["column"] == "Review" and r["columns"] == STAGES and r["stale"] is True
        # The board folder itself counts as the first stage.
        assert (await c.get("/kanban/card", params={"folder": board["folder"]})).json()["column"] == "Design"
        assert (await c.get("/kanban/card", params={"folder": "elsewhere"})).json()["board"] is False
        assert (await c.get("/kanban/card")).json()["board"] is False


async def test_the_card_route_needs_a_conversation(app):
    async with as_(app) as c:
        assert (await c.get("/kanban/card")).status_code == 403


async def test_the_board_routes_need_a_relayed_user(app):
    async with as_(app, conversation="key-1") as c:
        assert (await c.get("/kanban/user/boards")).status_code == 403
        assert (await c.put("/kanban/conversation/key-1/card", json={"column": "x"})).status_code == 403


# --- the user's moves --------------------------------------------------------------

async def test_the_user_records_a_move_and_the_agent_sees_it(app):
    board = await _board(app)
    review = _stage(board, "Review")
    async with as_(app, user="alice") as c:
        r = await c.put("/kanban/conversation/key-1/card", json={"column": review, "position": 1.5})
        assert r.status_code == 200 and r.json()["card"]["updated_by"] == "user"
        assert (await c.get("/kanban/conversation/key-1/card")).json()["card"]["position"] == 1.5
    async with as_(app, conversation="key-1") as c:
        body = (await c.get("/kanban/card", params={"folder": review})).json()
    assert body["card"]["updated_by"] == "user" and body["stale"] is True


async def test_a_bad_move_is_refused(app):
    board = await _board(app)
    review = _stage(board, "Review")
    bobs = await _board(app, owner="bob", name="Bob's")
    async with as_(app, user="alice") as c:
        for payload in [
            {"column": "nope"},
            {"column": board["folder"]},
            {"column": _stage(bobs, "Review")},
            {"column": review, "position": "x"},
            {"column": review, "position": True},
        ]:
            assert (await c.put("/kanban/conversation/key-1/card", json=payload)).status_code == 400, payload


# --- tools -------------------------------------------------------------------------

def _keys(sandboxes: dict[str, str] | None = None, calls: list[str] | None = None) -> CardKeys:
    """A fake agent-host naming each thread's Sandbox; thread-1 runs in conv-key-1."""
    sandboxes = {"thread-1": "conv-key-1"} if sandboxes is None else sandboxes

    def handle(req: httpx.Request) -> httpx.Response:
        conv = req.url.path.removeprefix("/conversations/")
        if calls is not None:
            calls.append(conv)
        if conv not in sandboxes:
            return httpx.Response(404, json={"error": "not found"})
        return httpx.Response(200, json={"id": conv, "sandbox": {"name": sandboxes[conv], "namespace": "ns"}})

    return CardKeys("http://agent-host", transport=httpx.MockTransport(handle))


async def test_the_agent_moves_its_card_by_filing_the_conversation(app, boards, folders, store):
    board = await _board(app)
    folders.conversations["key-1"] = Conversation(id="conv-1", owner="alice")
    folders.placements[("alice", "conv-1")] = board["folder"]
    mcp_tools.configure(boards, timedelta(minutes=30), _keys())
    out = await mcp_tools.kanban_set_status(column="in progress", note="  building the board  ", ctx=_ctx())
    assert not out.is_error and '"In progress"' in out.text
    assert folders.placements[("alice", "conv-1")] == _stage(board, "In progress")
    card = await store.card("key-1")
    assert (card.note, card.updated_by) == ("building the board", "agent")
    got = await mcp_tools.kanban_get_status(ctx=_ctx())
    assert '"building the board"' in got.text and '"Review"' in got.text


async def test_the_agent_follows_a_stage_the_user_renamed(app, boards, folders):
    board = await _board(app)
    folders.conversations["key-1"] = Conversation(id="conv-1", owner="alice")
    folders.placements[("alice", "conv-1")] = board["folder"]
    async with as_(app, user="alice") as c:
        await _save(c, board, [{**s, "name": "QA"} if s["name"] == "Review" else s for s in _kept(board)])
    mcp_tools.configure(boards, timedelta(minutes=30), _keys())
    assert (await mcp_tools.kanban_set_status(column="Review", ctx=_ctx())).is_error
    assert not (await mcp_tools.kanban_set_status(column="QA", ctx=_ctx())).is_error


async def test_the_agent_cannot_pick_an_unknown_stage(app, boards, folders, store):
    board = await _board(app)
    folders.conversations["key-1"] = Conversation(id="conv-1", owner="alice")
    folders.placements[("alice", "conv-1")] = board["folder"]
    mcp_tools.configure(boards, timedelta(minutes=30), _keys())
    out = await mcp_tools.kanban_set_status(column="backlog", ctx=_ctx())
    assert out.is_error and "not a stage" in out.text
    assert await store.card("key-1") is None
    assert folders.placements[("alice", "conv-1")] == board["folder"]


async def test_the_agent_off_a_board_is_told_so(app, boards, folders):
    folders.conversations["key-1"] = Conversation(id="conv-1", owner="alice")
    mcp_tools.configure(boards, timedelta(minutes=30), _keys())
    out = await mcp_tools.kanban_set_status(column="Design", ctx=_ctx())
    assert out.is_error and "isn't filed on a board" in out.text


async def test_the_card_key_is_looked_up_once(app, boards, folders):
    board = await _board(app)
    folders.conversations["key-1"] = Conversation(id="conv-1", owner="alice")
    folders.placements[("alice", "conv-1")] = board["folder"]
    calls: list[str] = []
    mcp_tools.configure(boards, timedelta(minutes=30), _keys(calls=calls))
    await mcp_tools.kanban_set_status(column="Review", ctx=_ctx())
    await mcp_tools.kanban_get_status(ctx=_ctx())
    assert calls == ["thread-1"]


async def test_an_unknown_conversation_writes_no_card(boards, store):
    mcp_tools.configure(boards, timedelta(minutes=30), _keys({}))
    out = await mcp_tools.kanban_set_status(column="Review", ctx=_ctx())
    assert out.is_error and "does not know" in out.text
    assert await store.card("thread-1") is None


async def test_a_conversation_on_someone_else_s_board_is_not_moved(app, boards, folders):
    bobs = await _board(app, owner="bob", name="Bob's")
    folders.conversations["key-1"] = Conversation(id="conv-1", owner="alice")
    # The store rejects a placement naming another user's folder.
    folders.placements[("alice", "conv-1")] = bobs["folder"]
    mcp_tools.configure(boards, timedelta(minutes=30), _keys())
    assert (await mcp_tools.kanban_set_status(column="Done", ctx=_ctx())).is_error


# --- the router client -------------------------------------------------------------

async def test_the_router_is_called_as_the_broker_for_the_user(tmp_path):
    (tmp_path / "token").write_text("tok")
    seen: list[httpx.Request] = []

    def handle(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        path = req.url.path
        if req.method == "POST":
            return httpx.Response(201, json={"id": "f-9", "name": "Design", "locked": True})
        if path == "/conversations/key-1":
            return httpx.Response(200, json={"id": "conv-1", "owner": "alice"})
        if path == "/folders":
            return httpx.Response(200, json={"folders": [], "placements": {"conv-1": "f-9"}})
        if req.method == "PUT":
            return httpx.Response(204)
        return httpx.Response(409, json={"error": "you already have a folder with that name there"})

    folders = RouterFolders("http://router/", str(tmp_path / "token"), httpx.MockTransport(handle))
    assert await folders.create("alice", "Design", "board-1") == "f-9"
    assert json.loads(seen[0].content) == {"name": "Design", "locked": True, "parentId": "board-1"}
    assert seen[0].headers["authorization"] == "Bearer tok" and seen[0].headers["x-scooter-user"] == "alice"
    assert await folders.conversation("key-1") == Conversation(id="conv-1", owner="alice", key="key-1")
    assert await folders.placement("alice", "conv-1") == "f-9"
    await folders.file("alice", "conv-1", "f-9")
    assert (str(seen[-1].url), json.loads(seen[-1].content)) == ("http://router/conversations/conv-1/folder", {"folderId": "f-9"})
    await folders.changed("alice", ["conv-1"])
    assert str(seen[-1].url) == "http://router/conversations/events"
    assert json.loads(seen[-1].content) == {"contrib": "kanban", "conversations": ["conv-1"]}
    with pytest.raises(FolderError) as e:
        await folders.update("alice", "f-9", name="Design")
    assert e.value.status == 409 and "already" in e.value.detail


async def test_the_hook_route_judges_staleness_from_the_runs_start(app, store):
    design = _stage(await _board(app), "Design")
    await store.put("key-1", column=design, by="agent", now=(NOW - timedelta(minutes=5)).isoformat())
    async with as_(app, conversation="key-1") as c:
        assert (await c.get("/kanban/card", params={"folder": design})).json()["stale"] is False
        since = (NOW - timedelta(minutes=1)).isoformat()
        r = (await c.get("/kanban/card", params={"folder": design, "since": since})).json()
        assert r["stale"] is True and r["now"] == NOW.isoformat()


@pytest.mark.parametrize("since", ["yesterday", "2026-01-01T00:00:00"])
async def test_a_bad_since_is_refused(app, since):
    design = _stage(await _board(app), "Design")
    async with as_(app, conversation="key-1") as c:
        assert (await c.get("/kanban/card", params={"folder": design, "since": since})).status_code == 400


# --- blockers ----------------------------------------------------------------------

class Sent:
    """Messages kanban sent, by conversation id."""

    def __init__(self) -> None:
        self.messages: list[tuple[str, str]] = []

    async def __call__(self, conversation_id: str, text: str) -> None:
        self.messages.append((conversation_id, text))


async def _cards(app, boards, folders, *names: str, stage: str = "Design") -> dict:
    """A board with a card per name: key-<name> runs conv-<name>; thread-<name> calls as it."""
    board = await _board(app)
    for n in names:
        folders.conversations[f"key-{n}"] = Conversation(id=f"conv-{n}", owner="alice", title=n.title())
        folders.placements[("alice", f"conv-{n}")] = _stage(board, stage)
    mcp_tools.configure(boards, timedelta(minutes=30), _keys({f"thread-{n}": f"conv-key-{n}" for n in names}))
    return board


async def test_a_blocked_card_stays_in_its_stage_until_its_blockers_are_done(app, boards, folders):
    board = await _cards(app, boards, folders, "api", "schema")
    out = await mcp_tools.kanban_set_blockers(blocked_by=["conv-schema"], ctx=_ctx("thread-api"))
    assert not out.is_error and '"Schema" (Design)' in out.text
    out = await mcp_tools.kanban_set_status(column="In progress", ctx=_ctx("thread-api"))
    assert out.is_error and "blocked by" in out.text and '"Schema" (Design)' in out.text
    assert folders.placements[("alice", "conv-api")] == _stage(board, "Design")
    # The same stage, or an earlier one, is still fine.
    assert not (await mcp_tools.kanban_set_status(column="Design", note="drafting", ctx=_ctx("thread-api"))).is_error
    got = await mcp_tools.kanban_get_status(ctx=_ctx("thread-api"))
    assert 'Blocked by "Schema" (Design)' in got.text
    assert not (await mcp_tools.kanban_set_status(column="Done", ctx=_ctx("thread-schema"))).is_error
    assert not (await mcp_tools.kanban_set_status(column="In progress", ctx=_ctx("thread-api"))).is_error


async def test_the_last_blocker_done_messages_the_blocked_card(app, boards, folders):
    sent = Sent()
    boards.send = sent
    await _cards(app, boards, folders, "ui", "api", "schema")
    await mcp_tools.kanban_set_blockers(blocked_by=["conv-api", "conv-schema"], ctx=_ctx("thread-ui"))
    await mcp_tools.kanban_set_status(column="Done", note="PR #1 merged", ctx=_ctx("thread-schema"))
    assert sent.messages == []
    await mcp_tools.kanban_set_status(column="Done", note="PR #2 merged", ctx=_ctx("thread-api"))
    assert [c for c, _ in sent.messages] == ["conv-ui"]
    assert '"Api" (note: "PR #2 merged")' in sent.messages[0][1] and '"Schema"' in sent.messages[0][1]
    # Confirming Done again sends nothing more.
    await mcp_tools.kanban_set_status(column="Done", ctx=_ctx("thread-api"))
    assert len(sent.messages) == 1


async def test_the_users_move_to_the_last_stage_releases_too(app, boards, folders):
    sent = Sent()
    boards.send = sent
    board = await _cards(app, boards, folders, "api", "schema")
    await mcp_tools.kanban_set_blockers(blocked_by=["conv-schema"], ctx=_ctx("thread-api"))
    done = _stage(board, "Done")
    folders.placements[("alice", "conv-schema")] = done
    async with as_(app, user="alice") as c:
        assert (await c.put("/kanban/conversation/key-schema/card", json={"column": done})).status_code == 200
        assert (await c.put("/kanban/conversation/key-schema/card", json={"column": done, "position": 2.0})).status_code == 200
    assert [c for c, _ in sent.messages] == ["conv-api"]


async def test_the_user_drags_a_blocked_card_anywhere(app, boards, folders):
    board = await _cards(app, boards, folders, "api", "schema")
    await mcp_tools.kanban_set_blockers(blocked_by=["conv-schema"], ctx=_ctx("thread-api"))
    async with as_(app, user="alice") as c:
        r = await c.put("/kanban/conversation/key-api/card", json={"column": _stage(board, "Review")})
    assert r.status_code == 200


async def test_blockers_are_checked(app, boards, folders):
    await _cards(app, boards, folders, "a", "b", "c")
    bobs = await _board(app, owner="bob", name="Bob's")
    folders.conversations["key-bob"] = Conversation(id="conv-bob", owner="bob", title="Bob")
    folders.placements[("bob", "conv-bob")] = _stage(bobs, "Design")
    folders.conversations["key-loose"] = Conversation(id="conv-loose", owner="alice", title="Loose")
    a = _ctx("thread-a")
    assert "itself" in (await mcp_tools.kanban_set_blockers(blocked_by=["conv-a"], ctx=a)).text
    for ref in ["conv-bob", "conv-loose", "nope"]:
        out = await mcp_tools.kanban_set_blockers(blocked_by=[ref], ctx=a)
        assert out.is_error and "not a card on this board" in out.text, ref
    assert not (await mcp_tools.kanban_set_blockers(blocked_by=["conv-b"], ctx=a)).is_error
    assert not (await mcp_tools.kanban_set_blockers(blocked_by=["conv-c"], card="conv-b", ctx=a)).is_error
    # c -> a would close a -> b -> c.
    out = await mcp_tools.kanban_set_blockers(blocked_by=["conv-a"], card="conv-c", ctx=a)
    assert out.is_error and "already waits on" in out.text
    assert "nothing" in (await mcp_tools.kanban_set_blockers(blocked_by=[], ctx=a)).text


async def test_a_blocker_that_left_the_board_no_longer_blocks(app, boards, folders, store):
    await _cards(app, boards, folders, "api", "schema")
    await mcp_tools.kanban_set_blockers(blocked_by=["conv-schema"], ctx=_ctx("thread-api"))
    del folders.placements[("alice", "conv-schema")]
    assert not (await mcp_tools.kanban_set_status(column="Review", ctx=_ctx("thread-api"))).is_error
    assert await store.blockers("key-api") == ["key-schema"]


async def test_a_planner_adds_cards_and_lists_them(app, boards, folders):
    board = await _cards(app, boards, folders, "plan")
    folders.conversations["key-schema"] = Conversation(id="conv-schema", owner="alice", title="Schema")
    folders.conversations["key-api"] = Conversation(id="conv-api", owner="alice", title="Api")
    plan = _ctx("thread-plan")
    out = await mcp_tools.kanban_add_card(conversation="conv-schema", ctx=plan)
    assert not out.is_error and '"Design"' in out.text
    out = await mcp_tools.kanban_add_card(conversation="conv-api", blocked_by=["conv-schema"], ctx=plan)
    assert not out.is_error and 'blocked by "Schema"' in out.text
    assert folders.placements[("alice", "conv-api")] == _stage(board, "Design")
    listed = json.loads((await mcp_tools.kanban_list_cards(ctx=plan)).text)
    assert listed["stages"][0] == {"name": "Design", "stage_id": _stage(board, "Design")}
    by_id = {c["id"]: c for c in listed["cards"]}
    assert by_id["conv-plan"]["this"] and not by_id["conv-api"]["this"]
    assert by_id["conv-api"]["blocked_by"] == [{"id": "conv-schema", "title": "Schema", "stage": "Design", "done": False}]


async def test_a_conversation_on_another_board_is_not_taken(app, boards, folders):
    await _cards(app, boards, folders, "plan")
    other = await _board(app, name="Other")
    folders.conversations["key-x"] = Conversation(id="conv-x", owner="alice", title="X")
    folders.placements[("alice", "conv-x")] = _stage(other, "Review")
    out = await mcp_tools.kanban_add_card(conversation="conv-x", ctx=_ctx("thread-plan"))
    assert out.is_error and "another board" in out.text


async def test_the_board_reads_a_card_s_blockers(app, boards, folders):
    await _cards(app, boards, folders, "api", "schema")
    await mcp_tools.kanban_set_blockers(blocked_by=["conv-schema"], ctx=_ctx("thread-api"))
    async with as_(app, user="alice") as c:
        got = (await c.get("/kanban/conversation/key-api/card")).json()
        assert got["blockers"] == [{"id": "conv-schema", "title": "Schema", "stage": "Design", "done": False}]
    async with as_(app, user="bob") as c:
        assert (await c.get("/kanban/conversation/key-api/card")).json()["blockers"] == []


async def test_the_hooks_see_only_open_blockers(app, boards, folders):
    board = await _cards(app, boards, folders, "api", "schema", "auth")
    await mcp_tools.kanban_set_blockers(blocked_by=["conv-schema", "conv-auth"], ctx=_ctx("thread-api"))
    folders.placements[("alice", "conv-auth")] = _stage(board, "Done")
    async with as_(app, conversation="key-api") as c:
        r = (await c.get("/kanban/card", params={"folder": _stage(board, "Design")})).json()
    assert r["blocked_by"] == [{"id": "conv-schema", "title": "Schema", "stage": "Design", "done": False}]


async def test_the_unblock_message_reaches_the_agent_host():
    seen: list[httpx.Request] = []

    def handle(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(202, json={"ok": True})

    send = AgentHostMessages("http://agent-host/", transport=httpx.MockTransport(handle))
    await send("conv-1", "go")
    assert str(seen[0].url) == "http://agent-host/conversations/conv-1/messages"
    assert json.loads(seen[0].content) == {"text": "go", "source": "kanban"}


# --- tags --------------------------------------------------------------------------

async def _tags(app, board: dict, *names: str, owner: str = "alice") -> dict[str, str]:
    """Add tags to a board; their ids by name."""
    async with as_(app, user=owner) as c:
        r = await _save(c, board, _kept(board), [{"name": n} for n in names])
        assert r.status_code == 200, r.text
    return {t["name"]: t["id"] for t in r.json()["board"]["tags"]}


async def test_the_user_tags_a_card_from_one_of_their_boards(app):
    board = await _board(app)
    ids = await _tags(app, board, "bug", "infra")
    other = await _tags(app, await _board(app, name="Home"), "garden")
    bobs = await _tags(app, await _board(app, owner="bob", name="Bob's"), "bug", owner="bob")
    async with as_(app, user="alice") as c:
        r = await c.put("/kanban/conversation/key-1/card/tags", json={"tags": [ids["infra"], ids["bug"], ids["bug"]]})
        assert r.status_code == 200 and r.json()["tags"] == [ids["infra"], ids["bug"]]
        got = (await c.get("/kanban/conversation/key-1/card")).json()
        assert got["card"] is None and sorted(got["tags"]) == sorted(ids.values())
        for tags in [[bobs["bug"]], [ids["bug"], other["garden"]], ["nope"], "bug", [1]]:
            assert (await c.put("/kanban/conversation/key-1/card/tags", json={"tags": tags})).status_code == 400, tags
        assert (await c.put("/kanban/conversation/key-1/card/tags", json={"tags": []})).json()["tags"] == []


async def test_tagging_a_card_can_make_new_tags_at_once(app, store):
    board = await _board(app)
    ids = await _tags(app, board, "bug")
    b = board["folder"]
    async with as_(app, user="alice") as c:
        r = await c.put(
            "/kanban/conversation/key-1/card/tags",
            json={"tags": [ids["bug"]], "board": b, "create": ["perf", "BUG", "perf"]},
        )
        assert r.status_code == 200, r.text
        made = r.json()["created"]
        assert [(t["name"], t["color"]) for t in made] == [("perf", "red")]
        assert r.json()["tags"] == [ids["bug"], made[0]["id"]]
        assert sorted(await store.card_tags("key-1")) == sorted(r.json()["tags"])
        listed = (await c.get("/kanban/user/boards")).json()["boards"][0]["tags"]
        assert [t["name"] for t in listed] == ["bug", "perf"]
        other = await _board(app, name="Home")
        for body in [
            {"tags": [], "create": ["x"]},
            {"tags": [ids["bug"]], "board": other["folder"]},
            {"tags": [], "board": b, "create": ["x" * 25]},
            {"tags": [], "board": b, "create": [f"t{i}" for i in range(6)]},
            {"tags": [], "board": b, "create": "x"},
        ]:
            assert (await c.put("/kanban/conversation/key-1/card/tags", json=body)).status_code == 400, body
    async with as_(app, user="bob") as c:
        body = {"tags": [], "board": b, "create": ["x"]}
        assert (await c.put("/kanban/conversation/key-2/card/tags", json=body)).status_code == 404


async def test_tagging_does_not_touch_the_status(app, store):
    board = await _board(app)
    ids = await _tags(app, board, "bug")
    await store.put("key-1", column=_stage(board, "Design"), by="agent", note="n", now="2026-01-01T00:00:00+00:00")
    async with as_(app, user="alice") as c:
        await c.put("/kanban/conversation/key-1/card/tags", json={"tags": [ids["bug"]]})
    card = await store.card("key-1")
    assert (card.updated_by, card.updated_at) == ("agent", "2026-01-01T00:00:00+00:00")


async def test_deleting_a_board_takes_its_tags_off_cards(app, store):
    board = await _board(app)
    ids = await _tags(app, board, "bug", "infra")
    async with as_(app, user="alice") as c:
        await c.put("/kanban/conversation/key-1/card/tags", json={"tags": [ids["bug"], ids["infra"]]})
        await c.delete(f"/kanban/user/boards/{board['folder']}")
    assert await store.card_tags("key-1") == []
    assert await store.tags(board["folder"]) == []


async def test_the_hooks_learn_the_board_s_and_card_s_tags(app):
    board = await _board(app)
    ids = await _tags(app, board, "bug", "infra")
    async with as_(app, user="alice") as c:
        await c.put("/kanban/conversation/key-1/card/tags", json={"tags": [ids["infra"]]})
    async with as_(app, conversation="key-1") as c:
        body = (await c.get("/kanban/card", params={"folder": _stage(board, "Design")})).json()
    assert (body["tags"], body["card_tags"]) == (["bug", "infra"], ["infra"])


async def test_the_agent_tags_its_card_by_name(app, boards, folders, store):
    board = await _board(app)
    ids = await _tags(app, board, "Bug", "infra")
    folders.conversations["key-1"] = Conversation(id="conv-1", owner="alice")
    folders.placements[("alice", "conv-1")] = board["folder"]
    mcp_tools.configure(boards, timedelta(minutes=30), _keys())
    out = await mcp_tools.kanban_set_tags(tags=[" bug "], ctx=_ctx())
    assert not out.is_error and 'Tags: "Bug". Board tags: "Bug", "infra".' in out.text
    assert await store.card_tags("key-1") == [ids["Bug"]]
    assert await store.card("key-1") is None
    got = await mcp_tools.kanban_get_status(ctx=_ctx())
    assert 'Tags: "Bug".' in got.text
    assert not (await mcp_tools.kanban_set_tags(tags=[], ctx=_ctx())).is_error
    assert await store.card_tags("key-1") == []


async def test_the_agent_cannot_invent_a_tag(app, boards, folders, store):
    board = await _board(app)
    await _tags(app, board, "bug")
    folders.conversations["key-1"] = Conversation(id="conv-1", owner="alice")
    folders.placements[("alice", "conv-1")] = board["folder"]
    mcp_tools.configure(boards, timedelta(minutes=30), _keys())
    out = await mcp_tools.kanban_set_tags(tags=["bug", "feature"], ctx=_ctx())
    assert out.is_error and "`feature`" in out.text and "`bug`" in out.text
    assert await store.card_tags("key-1") == []


async def test_a_board_without_tags_says_nothing_of_them(app, boards, folders):
    board = await _board(app)
    folders.conversations["key-1"] = Conversation(id="conv-1", owner="alice")
    folders.placements[("alice", "conv-1")] = board["folder"]
    mcp_tools.configure(boards, timedelta(minutes=30), _keys())
    assert "Tags" not in (await mcp_tools.kanban_get_status(ctx=_ctx())).text


# --- details -----------------------------------------------------------------------

async def test_the_user_edits_a_card_s_description_and_priority(app, boards, folders, store):
    await _cards(app, boards, folders, "api")
    async with as_(app, user="alice") as c:
        r = await c.patch("/kanban/conversation/key-api/details", json={"description": "Add **routes**", "priority": "High"})
        assert r.status_code == 200, r.text
        assert (r.json()["description"], r.json()["priority"], r.json()["updated_by"]) == ("Add **routes**", "high", "user")
        r = await c.patch("/kanban/conversation/key-api/details", json={"priority": "none"})
        assert (r.json()["description"], r.json()["priority"]) == ("Add **routes**", "none")
        assert (await c.get("/kanban/conversation/key-api/card")).json()["priority"] == "none"
    # Editing details is not a move, so the agent owes no status for it.
    assert await store.card("key-api") is None


async def test_bad_details_are_refused(app, boards, folders):
    await _cards(app, boards, folders, "api")
    async with as_(app, user="alice") as c:
        for body in [{}, {"priority": "soon"}, {"priority": 3}, {"description": ["x"]}]:
            assert (await c.patch("/kanban/conversation/key-api/details", json=body)).status_code == 400, body
    async with as_(app, user="bob") as c:
        assert (await c.patch("/kanban/conversation/key-api/details", json={"priority": "low"})).status_code == 404


async def test_the_agent_sets_its_card_s_details(app, boards, folders, store):
    await _cards(app, boards, folders, "api")
    api = _ctx("thread-api")
    assert (await mcp_tools.kanban_set_details(ctx=api)).is_error
    assert "one of none" in (await mcp_tools.kanban_set_details(priority="asap", ctx=api)).text
    out = await mcp_tools.kanban_set_details(description="Routes for the board.", priority="urgent", ctx=api)
    assert not out.is_error and "priority urgent" in out.text
    assert (await store.details("key-api")).updated_by == "agent"
    got = (await mcp_tools.kanban_get_status(ctx=api)).text
    assert "Priority: urgent." in got and got.endswith("Description:\nRoutes for the board.")


async def test_the_hooks_read_the_card_s_details(app, boards, folders):
    board = await _cards(app, boards, folders, "api")
    await mcp_tools.kanban_set_details(description="Routes.", ctx=_ctx("thread-api"))
    async with as_(app, conversation="key-api") as c:
        r = (await c.get("/kanban/card", params={"folder": _stage(board, "Design")})).json()
    assert (r["details"]["description"], r["details"]["priority"]) == ("Routes.", "none")


async def test_the_user_sets_blockers_and_sees_what_a_card_blocks(app, boards, folders):
    await _cards(app, boards, folders, "ui", "api", "schema")
    async with as_(app, user="alice") as c:
        r = await c.put("/kanban/conversation/key-ui/card/blockers", json={"blocked_by": ["conv-api"]})
        assert r.status_code == 200, r.text
        assert [b["id"] for b in r.json()["blockers"]] == ["conv-api"]
        r = await c.put("/kanban/conversation/key-api/card/blockers", json={"blocked_by": ["conv-ui"]})
        assert r.status_code == 409 and "already waits on" in r.json()["detail"]
        assert (await c.put("/kanban/conversation/key-ui/card/blockers", json={"blocked_by": "conv-api"})).status_code == 400
        api = (await c.get("/kanban/conversation/key-api/details")).json()
        assert api["blocking"] == [{"id": "conv-ui", "title": "Ui", "stage": "Design", "done": False}]
        assert api["blocked_by"] == []
        ui = (await c.get("/kanban/conversation/key-ui/details")).json()
        assert [b["id"] for b in ui["blocked_by"]] == ["conv-api"]
    async with as_(app, user="bob") as c:
        r = await c.put("/kanban/conversation/key-ui/card/blockers", json={"blocked_by": []})
        assert r.status_code == 409


async def test_clearing_the_last_open_blocker_tells_the_agent(app, boards, folders):
    sent = Sent()
    boards.send = sent
    await _cards(app, boards, folders, "ui", "api")
    async with as_(app, user="alice") as c:
        await c.put("/kanban/conversation/key-ui/card/blockers", json={"blocked_by": ["conv-api"]})
        assert sent.messages == []
        await c.put("/kanban/conversation/key-ui/card/blockers", json={"blocked_by": []})
        await c.put("/kanban/conversation/key-ui/card/blockers", json={"blocked_by": []})
    assert [c for c, _ in sent.messages] == ["conv-ui"] and "removed" in sent.messages[0][1]


# --- loading and pushing a board ----------------------------------------------------

async def test_the_board_loads_the_cards_it_asks_for_in_one_read(app, boards, folders):
    board = await _cards(app, boards, folders, "api", "schema", "ui")
    folders.conversations["key-gone"] = Conversation(id="conv-gone", owner="alice", title="Gone")
    folders.placements[("alice", "conv-gone")] = _stage(board, "Design")
    folders.placements[("alice", "conv-ui")] = board["folder"]
    assert not (await mcp_tools.kanban_set_blockers(blocked_by=["conv-schema", "conv-gone"], ctx=_ctx("thread-api"))).is_error
    # A blocker off the board no longer counts.
    folders.placements[("alice", "conv-gone")] = "elsewhere"
    await mcp_tools.kanban_set_status(column="Review", note="in review", ctx=_ctx("thread-schema"))
    await mcp_tools.kanban_set_details(priority="high", ctx=_ctx("thread-api"))
    async with as_(app, user="alice") as c:
        saved = (await _save(c, board, _kept(board), [{"name": "bug"}])).json()
        tag_id = saved["board"]["tags"][0]["id"]
        assert (await c.put("/kanban/conversation/key-ui/card/tags", json={"tags": [tag_id]})).status_code == 200
        asked = ["conv-api", "conv-schema", "conv-ui", "conv-gone", "conv-nobody"]
        r = await c.post(f"/kanban/user/boards/{board['folder']}/cards", json={"conversations": asked})
        assert r.status_code == 200, r.text
        cards = r.json()["cards"]
        assert set(cards) == {"conv-api", "conv-schema", "conv-ui"}
        # A blocker the board didn't ask for still resolves.
        only = (await c.post(f"/kanban/user/boards/{board['folder']}/cards", json={"conversations": ["conv-api"]})).json()
        assert only["cards"] == {"conv-api": cards["conv-api"]}
        # Each entry is what the one-card route answers.
        for conv in cards:
            one = (await c.get(f"/kanban/conversation/key-{conv.removeprefix('conv-')}/card")).json()
            assert cards[conv] == one, conv
    assert cards["conv-api"]["blockers"] == [{"id": "conv-schema", "title": "Schema", "stage": "Review", "done": False}]
    assert cards["conv-api"]["priority"] == "high" and cards["conv-ui"]["tags"] == [tag_id]
    assert cards["conv-schema"]["card"]["note"] == "in review" and cards["conv-ui"]["card"] is None


async def test_only_the_owner_loads_a_board(app, boards, folders):
    board = await _cards(app, boards, folders, "api")
    ask = {"conversations": ["conv-api"]}
    async with as_(app, user="bob") as c:
        r = await c.post(f"/kanban/user/boards/{board['folder']}/cards", json=ask)
        assert r.status_code == 404
    async with as_(app, user="alice") as c:
        assert (await c.post("/kanban/user/boards/..x/cards", json=ask)).status_code == 400
        url = f"/kanban/user/boards/{board['folder']}/cards"
        for body in [{}, {"conversations": "conv-api"}, {"conversations": [""]}, {"conversations": ["c"] * 201}]:
            assert (await c.post(url, json=body)).status_code == 400, body


async def test_card_changes_push_to_the_owners_boards(app, boards, folders):
    board = await _cards(app, boards, folders, "api", "schema")
    folders.pushed.clear()
    await mcp_tools.kanban_set_status(column="In progress", ctx=_ctx("thread-api"))
    await mcp_tools.kanban_set_blockers(blocked_by=["conv-schema"], ctx=_ctx("thread-api"))
    await mcp_tools.kanban_set_details(description="the plan", ctx=_ctx("thread-api"))
    assert folders.pushed == [("alice", ["conv-api"])] * 3
    folders.pushed.clear()
    async with as_(app, user="alice") as c:
        await c.put("/kanban/conversation/key-api/card", json={"column": _stage(board, "Review")})
        await c.patch("/kanban/conversation/key-api/details", json={"priority": "low"})
        await _save(c, board, _kept(board), [{"name": "bug"}])
    assert folders.pushed == [("alice", ["conv-api"]), ("alice", ["conv-api"]), ("alice", [])]


async def test_a_failed_push_leaves_the_change_made(app, boards, folders, store):
    await _cards(app, boards, folders, "api")
    folders.push_error = True
    out = await mcp_tools.kanban_set_status(column="Review", note="up", ctx=_ctx("thread-api"))
    assert not out.is_error
    assert (await store.card("key-api")).note == "up"
