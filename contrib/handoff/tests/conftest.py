from __future__ import annotations

import json

import httpx
import pytest
from scooter_broker_lib.owner import OwnerResolver

from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_contrib_handoff.agent_host import AgentHost
from scooter_contrib_handoff.store import HandoffStore, _Base

@pytest.fixture
async def store():
    s = HandoffStore(sqlite_config())
    await create_schema(s, _Base)
    return s


class FakeRouter:
    """The router's conversation surface, over in-memory rows."""

    def __init__(self) -> None:
        # id -> list row; "visibility" private rows answer 404 like the real router.
        self.rows: dict[str, dict] = {}
        self.transcripts: dict[str, list[dict]] = {}
        self.authors: dict[str, tuple[str | None, ...]] = {}
        self.spawns: list[tuple[str, dict]] = []
        self.spawn_status = 201
        self.filed: list[tuple[str, str, str]] = []
        self.file_status = 204
        # owner -> their folders, as GET /folders lists them.
        self.folders: dict[str, list[dict]] = {"alice": [
            {"id": "f-infra", "name": "Infra"}, {"id": "f-design", "name": "Design", "parentId": "f-infra"},
        ]}
        # False mimics a router without the broker in conversationController.readers.
        self.owned_enabled = True

    def add(self, cid: str, *, title: str = "", owner: str = "alice", at: int = 1000,
            visibility: str = "shared", messages: list[tuple[str, str]] = (), parent: str | None = None,
            authors: tuple[str | None, ...] | None = None) -> None:
        self.rows[cid] = {"id": cid, "title": title, "owner": owner, "lastActivityAt": at,
                          "visibility": visibility, "parentId": parent}
        self.transcripts[cid] = [{"role": r, "content": t} for r, t in messages]
        self.authors[cid] = (owner,) if authors is None else authors

    async def view(self, cid: str) -> dict | None:
        """agent-host's view of one conversation, as OwnerResolver fetches it."""
        row = self.rows.get(cid)
        if row is None:
            return None
        return {"owner": row["owner"], "visibility": row["visibility"],
                "authors": [{"user": u} for u in self.authors[cid]]}

    def _visible(self, cid: str) -> dict | None:
        row = self.rows.get(cid)
        return row if row and row["visibility"] == "shared" else None

    def _owned(self, source: str) -> list[dict] | None:
        src = self.rows.get(source)
        if not self.owned_enabled or src is None:
            return None
        if src["visibility"] != "private":
            return []
        return [r for r in self.rows.values() if src["owner"] and r["owner"] == src["owner"]]

    def handler(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.strip("/").split("/")
        if request.method == "GET" and len(parts) >= 3 and parts[0] == "conversations" and parts[2] == "owned":
            owned = self._owned(parts[1])
            if owned is None:
                return httpx.Response(404, json={"error": "unknown source conversation"})
            if len(parts) == 3:
                return httpx.Response(200, json=owned)
            if len(parts) == 5 and parts[4] == "messages" and parts[3] in {r["id"] for r in owned}:
                return httpx.Response(200, json={"messages": self.transcripts[parts[3]], "fromSeq": 1, "done": True})
            return httpx.Response(404, json={"error": "not owned"})
        if request.method == "GET" and parts == ["conversations"]:
            return httpx.Response(200, json=[r for r in self.rows.values() if r["visibility"] == "shared"])
        if request.method == "GET" and parts == ["folders"]:
            return httpx.Response(200, json={"folders": self.folders.get(request.headers.get("x-scooter-user", ""), []), "placements": {}})
        if request.method == "PUT" and len(parts) == 3 and parts[2] == "folder":
            self.filed.append((request.headers.get("x-scooter-user", ""), parts[1], json.loads(request.content)["folderId"]))
            return httpx.Response(self.file_status)
        if request.method == "POST" and len(parts) == 3 and parts[2] == "spawns":
            body = json.loads(request.content)
            self.spawns.append((parts[1], body))
            if self.spawn_status != 201:
                return httpx.Response(self.spawn_status, json={"error": "nope", "id": "half-made"})
            src = self.rows.get(parts[1], {})
            return httpx.Response(201, json={"id": f"new-{len(self.spawns)}", "visibility": src.get("visibility", "shared")})
        if len(parts) >= 2 and parts[0] == "conversations" and self._visible(parts[1]) is None:
            return httpx.Response(404, json={"error": "not found"})
        if request.method == "GET" and len(parts) == 2:
            return httpx.Response(200, json=self.rows[parts[1]])
        if request.method == "GET" and len(parts) == 3 and parts[2] == "messages":
            msgs = self.transcripts[parts[1]]
            return httpx.Response(200, json={"messages": msgs, "fromSeq": 1, "done": True})
        return httpx.Response(500, json={"error": f"unexpected {request.method} {request.url.path}"})


@pytest.fixture
def router() -> FakeRouter:
    return FakeRouter()


@pytest.fixture
def agent_host(router: FakeRouter) -> AgentHost:
    return AgentHost("http://router.test", transport=httpx.MockTransport(router.handler))


@pytest.fixture
def owners(router: FakeRouter) -> OwnerResolver:
    return OwnerResolver(router.view, ttl=0)
