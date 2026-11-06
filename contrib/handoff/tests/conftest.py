from __future__ import annotations

import json

import httpx
import pytest

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
        self.spawns: list[tuple[str, dict]] = []
        self.spawn_status = 201

    def add(self, cid: str, *, title: str = "", owner: str = "alice", at: int = 1000,
            visibility: str = "shared", messages: list[tuple[str, str]] = (), parent: str | None = None) -> None:
        self.rows[cid] = {"id": cid, "title": title, "owner": owner, "lastActivityAt": at,
                          "visibility": visibility, "parentId": parent}
        self.transcripts[cid] = [{"role": r, "content": t} for r, t in messages]

    def _visible(self, cid: str) -> dict | None:
        row = self.rows.get(cid)
        return row if row and row["visibility"] == "shared" else None

    def handler(self, request: httpx.Request) -> httpx.Response:
        parts = request.url.path.strip("/").split("/")
        if request.method == "GET" and parts == ["conversations"]:
            return httpx.Response(200, json=[r for r in self.rows.values() if r["visibility"] == "shared"])
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
