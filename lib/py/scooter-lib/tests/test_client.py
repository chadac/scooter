"""scooter_lib.client against a fake agent-host, broker and scheduler (httpx.MockTransport)."""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from scooter_lib.client import ScooterClient, SpawnError


class _Fake:
    def __init__(self, create_status: int = 201, prompt_status: int = 200, conv_id: str | None = "conv-1"):
        self.create_status, self.prompt_status, self.conv_id = create_status, prompt_status, conv_id
        self.calls: list[tuple[str, str, dict, str | None]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else {}
        self.calls.append((request.method, str(request.url), body, request.headers.get("authorization")))
        path = request.url.path
        if path == "/conversations":
            if self.create_status >= 300:
                return httpx.Response(self.create_status, text="nope")
            return httpx.Response(self.create_status, json={"id": self.conv_id} if self.conv_id else {})
        if path == "/agui":
            return httpx.Response(self.prompt_status)
        if path == "/users":
            return httpx.Response(200, json={"configured": True, "users": [{"id": "alice"}, {"id": "bob"}]})
        return httpx.Response(200, json={"ok": True})


def _client(fake: _Fake, tmp_path, token: str | None = "tok-1") -> ScooterClient:
    path = tmp_path / "token"
    if token is not None:
        path.write_text(token + "\n")
    return ScooterClient(
        agent_host_url="http://agent-host:8080/",
        broker_url="http://broker:8080",
        scheduler_url="http://scheduler:8080",
        token_path=str(path),
        run_token="run-secret",
        transport=httpx.MockTransport(fake.handler),
        backoff_seconds=0.0,
    )


def run(coro):
    return asyncio.run(coro)


def test_spawn_creates_then_prompts_with_owner_model_and_source(tmp_path):
    fake = _Fake()

    async def go():
        async with _client(fake, tmp_path) as c:
            return await c.spawn_conversation("alice", "hi", title="Digest", model="fast-1")

    assert run(go()) == "conv-1"
    (m1, u1, create, a1), (m2, u2, prompt, a2) = fake.calls
    assert (m1, u1) == ("POST", "http://agent-host:8080/conversations")
    assert create == {"title": "Digest", "owner": "alice", "model": "fast-1"}
    assert u2 == "http://agent-host:8080/agui"
    assert prompt["threadId"] == "conv-1" and prompt["owner"] == "alice" and prompt["model"] == "fast-1"
    assert prompt["source"] == "system"
    assert prompt["messages"] == [{"role": "user", "content": "hi"}]
    assert a1 == a2 == "Bearer tok-1"


def test_optional_fields_are_omitted(tmp_path):
    fake = _Fake()

    async def go():
        async with _client(fake, tmp_path) as c:
            await c.spawn_conversation(None, "hi", source="scheduler")

    run(go())
    assert fake.calls[0][2] == {}
    assert "owner" not in fake.calls[1][2] and "model" not in fake.calls[1][2]
    assert fake.calls[1][2]["source"] == "scheduler"


def test_oneshot_is_sent_on_create(tmp_path):
    fake = _Fake()

    async def go():
        async with _client(fake, tmp_path) as c:
            await c.spawn_conversation(None, "hi", oneshot=True)
            await c.spawn_conversation(None, "hi")

    run(go())
    creates = [body for _, url, body, _ in fake.calls if url.endswith("/conversations")]
    assert creates == [{"oneshot": True}, {}]


def test_the_token_is_reread_per_request_and_omitted_when_unreadable(tmp_path):
    fake = _Fake()

    async def go():
        async with _client(fake, tmp_path, token="old") as c:
            await c.list_users()
            (tmp_path / "token").write_text("rotated")
            await c.list_users()
            (tmp_path / "token").unlink()
            await c.list_users()

    run(go())
    assert [a for *_, a in fake.calls] == ["Bearer old", "Bearer rotated", None]


@pytest.mark.parametrize(
    "fake, match",
    [(_Fake(create_status=500), "create failed: HTTP 500"), (_Fake(conv_id=None), "no id"), (_Fake(prompt_status=403), "prompt failed: HTTP 403")],
)
def test_a_refused_spawn_raises(tmp_path, fake, match):
    async def go():
        async with _client(fake, tmp_path) as c:
            await c.spawn_conversation("alice", "hi")

    with pytest.raises(SpawnError, match=match):
        run(go())


def test_a_transport_error_raises_spawn_error(tmp_path):
    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    async def go():
        c = ScooterClient(
            agent_host_url="http://h", token_path=str(tmp_path / "t"), transport=httpx.MockTransport(boom), backoff_seconds=0.0
        )
        async with c:
            await c.spawn_conversation("alice", "hi")

    with pytest.raises(SpawnError, match="ConnectError"):
        run(go())


def test_list_users_broker_and_report_spawn(tmp_path):
    fake = _Fake()

    async def go():
        async with _client(fake, tmp_path) as c:
            users = await c.list_users()
            r = await c.broker.get("/personalization/system/eligible", params={"limit": 3})
            await c.report_spawn("run-7", "conv-1", "alice")
            return users, r.status_code

    users, status = run(go())
    assert [u["id"] for u in users] == ["alice", "bob"] and status == 200
    urls = [u for _, u, _, _ in fake.calls]
    assert urls[1] == "http://broker:8080/personalization/system/eligible?limit=3"
    assert fake.calls[1][3] == "Bearer tok-1"
    assert urls[2] == "http://scheduler:8080/runs/run-7/conversations"
    assert fake.calls[2][2] == {"conversation_id": "conv-1", "owner": "alice"}
    # A spawn is recorded with the run's own secret, not the pod's SA token.
    assert fake.calls[2][3] == "Bearer run-secret"


def test_from_env_reads_the_task_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_HOST_URL", "http://ah/")
    monkeypatch.setenv("BROKER_URL", "http://br")
    monkeypatch.setenv("SCHEDULER_URL", "http://sc/")
    monkeypatch.setenv("SCOOTER_TOKEN_PATH", str(tmp_path / "tok"))
    monkeypatch.setenv("SCOOTER_BROKER_TOKEN_PATH", str(tmp_path / "broker-tok"))
    monkeypatch.setenv("SCOOTER_TASK_RUN_TOKEN", "rt")
    c = ScooterClient.from_env()
    try:
        assert (c.agent_host_url, c.scheduler_url, str(c.broker.base_url)) == ("http://ah", "http://sc", "http://br")
        assert c.auth.path == str(tmp_path / "tok")
        assert c.broker_auth.path == str(tmp_path / "broker-tok") and c.run_token == "rt"
    finally:
        run(c.aclose())


def test_without_an_agent_host_url_spawn_fails_clearly(tmp_path):
    async def go():
        async with ScooterClient(agent_host_url="", token_path=str(tmp_path / "t")) as c:
            await c.spawn_conversation("alice", "hi")

    with pytest.raises(SpawnError, match="AGENT_HOST_URL"):
        run(go())


class _Flaky(_Fake):
    """Fails the first `fail` calls to `path` with `exc` (or `status`), then behaves."""

    def __init__(self, path, fail, exc=None, status=None):
        super().__init__()
        self.path, self.fail, self.exc, self.status = path, fail, exc, status

    def handler(self, request):
        if request.url.path == self.path and self.fail > 0:
            self.fail -= 1
            self.calls.append((request.method, str(request.url), {}, None))
            if self.exc:
                raise self.exc("boom", request=request)
            return httpx.Response(self.status)
        return super().handler(request)


def _paths(fake):
    return [httpx.URL(u).path for _, u, _, _ in fake.calls]


def test_a_create_read_timeout_is_retried(tmp_path):
    fake = _Flaky("/conversations", 1, exc=httpx.ReadTimeout)

    async def go():
        async with _client(fake, tmp_path) as c:
            return await c.spawn_conversation("alice", "hi")

    assert run(go()) == "conv-1"
    assert _paths(fake) == ["/conversations", "/conversations", "/agui"]


def test_a_refused_prompt_503_is_retried(tmp_path):
    fake = _Flaky("/agui", 2, status=503)

    async def go():
        async with _client(fake, tmp_path) as c:
            return await c.spawn_conversation("alice", "hi")

    assert run(go()) == "conv-1"
    assert _paths(fake).count("/agui") == 3


def test_a_prompt_read_timeout_is_not_retried_since_it_may_have_been_delivered(tmp_path):
    fake = _Flaky("/agui", 1, exc=httpx.ReadTimeout)

    async def go():
        async with _client(fake, tmp_path) as c:
            await c.spawn_conversation("alice", "hi")

    with pytest.raises(SpawnError, match="prompt failed: ReadTimeout") as e:
        run(go())
    assert e.value.conversation_id == "conv-1"
    assert _paths(fake).count("/agui") == 1


def test_a_502_create_gives_up_after_the_attempts(tmp_path):
    fake = _Fake(create_status=502)

    async def go():
        async with _client(fake, tmp_path) as c:
            await c.spawn_conversation("alice", "hi")

    with pytest.raises(SpawnError, match="create failed: HTTP 502"):
        run(go())
    assert _paths(fake) == ["/conversations"] * 3


def test_a_passed_http_client_is_used_and_left_open(tmp_path):
    fake = _Fake()
    http = httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))

    async def go():
        async with ScooterClient(agent_host_url="http://h", token_path=str(tmp_path / "t"), http=http) as c:
            await c.spawn_conversation(None, "hi")
        assert not http.is_closed
        await http.aclose()

    run(go())
    assert _paths(fake) == ["/conversations", "/agui"]


def test_the_broker_uses_its_own_token_when_given(tmp_path):
    fake = _Fake()
    (tmp_path / "agent-host").write_text("ah")
    (tmp_path / "broker").write_text("br")

    async def go():
        async with ScooterClient(
            agent_host_url="http://h", broker_url="http://b", token_path=str(tmp_path / "agent-host"),
            broker_token_path=str(tmp_path / "broker"), transport=httpx.MockTransport(fake.handler),
        ) as c:
            await c.list_users()
            await c.broker.get("/x/system/y")

    run(go())
    assert [a for *_, a in fake.calls] == ["Bearer ah", "Bearer br"]


def test_report_spawn_without_a_run_token_fails_clearly(tmp_path):
    async def go():
        async with ScooterClient(agent_host_url="http://h", scheduler_url="http://s", token_path=str(tmp_path / "t")) as c:
            await c.report_spawn("run-1", "conv-1", "alice")

    with pytest.raises(RuntimeError, match="SCOOTER_TASK_RUN_TOKEN"):
        run(go())
