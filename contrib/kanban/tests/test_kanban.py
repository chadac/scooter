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
from scooter_contrib_kanban.boards import Boards
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
        mine[f"f-{self.next}"] = FakeFolder(name, parent, float(self.next))
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
        assert (await c.post(f"/kanban/user/boards/{b}/stages", json={"name": "Mine"})).status_code == 404
        stage = _stage(board, "Design")
        assert (await c.delete(f"/kanban/user/boards/{b}/stages/{stage}")).status_code == 404
    assert folders.names("alice") == ["Infra"] and folders.names("alice", b) == STAGES


async def test_the_router_refusing_a_name_reaches_the_user(app):
    board = await _board(app)
    async with as_(app, user="alice") as c:
        r = await c.post("/kanban/user/boards", json={"name": "Infra"})
        assert r.status_code == 409 and "already" in r.json()["detail"]
        assert (await c.post("/kanban/user/boards", json={"name": " "})).status_code == 400
        r = await c.post(f"/kanban/user/boards/{board['folder']}/stages", json={"name": "Review"})
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

async def test_the_user_adds_renames_reorders_and_deletes_stages(app, folders):
    board = await _board(app)
    b = board["folder"]
    async with as_(app, user="alice") as c:
        r = await c.post(f"/kanban/user/boards/{b}/stages", json={"name": "Backlog"})
        stages = r.json()["boards"][0]["stages"]
        assert [s["label"] for s in stages] == [*STAGES, "Backlog"]
        backlog = stages[-1]["id"]
        # Before Design, which sits at position 1.
        r = await c.patch(f"/kanban/user/boards/{b}/stages/{backlog}", json={"position": 0.5})
        assert [s["label"] for s in r.json()["boards"][0]["stages"]] == ["Backlog", *STAGES]
        r = await c.patch(f"/kanban/user/boards/{b}/stages/{_stage(board, 'Review')}", json={"name": "QA"})
        assert [s["label"] for s in r.json()["boards"][0]["stages"]] == ["Backlog", "Design", "In progress", "QA", "Done"]
        r = await c.delete(f"/kanban/user/boards/{b}/stages/{_stage(board, 'Done')}")
        assert [s["label"] for s in r.json()["boards"][0]["stages"]] == ["Backlog", "Design", "In progress", "QA"]
        assert (await c.patch(f"/kanban/user/boards/{b}/stages/{backlog}", json={})).status_code == 400
    # The sidebar lists stages in board order.
    assert folders.names("alice", b) == ["Backlog", "Design", "In progress", "QA"]


async def test_deleting_a_stage_moves_its_cards_to_the_first(app, folders):
    board = await _board(app)
    b, review = board["folder"], _stage(board, "Review")
    folders.placements[("alice", "conv-1")] = review
    async with as_(app, user="alice") as c:
        await c.delete(f"/kanban/user/boards/{b}/stages/{review}")
    assert folders.placements[("alice", "conv-1")] == b
    async with as_(app, conversation="key-1") as c:
        assert (await c.get("/kanban/card", params={"folder": b})).json()["column"] == "Design"


async def test_the_last_stage_stays(app):
    board = await _board(app)
    b = board["folder"]
    async with as_(app, user="alice") as c:
        for s in board["stages"][:-1]:
            assert (await c.delete(f"/kanban/user/boards/{b}/stages/{s['id']}")).status_code == 200
        r = await c.delete(f"/kanban/user/boards/{b}/stages/{board['stages'][-1]['id']}")
    assert r.status_code == 409 and "at least one" in r.json()["detail"]


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
        await c.patch(f"/kanban/user/boards/{board['folder']}/stages/{_stage(board, 'Review')}", json={"name": "QA"})
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
