"""generate_image: fallthrough on a backend error, params validation against the
chosen model's schema, and the single-candidate behavior of naming a backend.

A tool handler is a plain async function, so it is tested by building it with
fakes and calling it directly — no fastmcp server needed.
"""

from __future__ import annotations

from scooter_broker_lib.mcp import ToolContext, ToolResult
from scooter_broker_lib.types import Identity
from scooter_contrib_imagegen import mcp_tools
from scooter_contrib_imagegen.manifest import BackendManifest, ModelManifest
from scooter_contrib_imagegen.selectors import priority
from scooter_contrib_imagegen.store import TodayUsage

_PARAMS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"quality": {"type": "string", "enum": ["standard", "premium"]}},
}

_MODEL = ModelManifest(name="m1", params_schema=_PARAMS_SCHEMA)


class FakeBackend:
    def __init__(self, name: str, result=None, error: Exception | None = None, model: ModelManifest = _MODEL):
        self.name = name
        self.manifest = BackendManifest(models=(model,))
        self._result = result
        self._error = error
        self.calls = 0

    async def generate(self, request):
        self.calls += 1
        if self._error:
            raise self._error
        return self._result


class FakeStore:
    def __init__(self):
        self.records: list[tuple[str, str, str]] = []

    async def usage_today(self, user_id: str) -> TodayUsage:
        return TodayUsage(total=0, per_backend={})

    async def record(self, user_id: str, backend: str, model: str) -> None:
        self.records.append((user_id, backend, model))


class FakeMcp:
    def __init__(self):
        self.fn = None
        self.description = ""

    def tool(self, fn, *, name, description):
        self.fn = fn
        self.description = description


def _ctx() -> ToolContext:
    identity = Identity(conversation_id="conv-1", namespace="ns", service_account="sa", owner="alice")
    return ToolContext(identity=identity, provider=None, upstream=None, links=None)


def _build(backends: dict, backend_configs: dict, store: FakeStore, selector=priority, daily_limit=50):
    mcp = FakeMcp()
    mcp_tools.build_generate_image_tool(
        mcp,
        backends=backends,
        backend_configs=backend_configs,
        selector=selector,
        selector_name="priority",
        store=store,
        daily_limit=daily_limit,
        agent_host_url="http://agent-host",
    )
    return mcp.fn


async def test_falls_through_to_the_next_backend_on_a_generate_error(monkeypatch):
    failing = FakeBackend("a", error=RuntimeError("upstream exploded"))
    working = FakeBackend("b", result=[b"PNG"])
    store = FakeStore()
    fn = _build(
        backends={"a": failing, "b": working},
        backend_configs={"a": {"priority": 200}, "b": {"priority": 100}},
        store=store,
    )
    monkeypatch.setattr(mcp_tools, "write_image", _ok_path)

    result: ToolResult = await fn(prompt="a cat", ctx=_ctx())

    assert not result.is_error
    assert failing.calls == 1
    assert working.calls == 1
    assert "b" in result.text
    assert store.records == [("alice", "b", "m1")]


async def test_rejects_params_that_do_not_match_the_models_schema_with_the_schema_in_the_error():
    backend = FakeBackend("a", result=[b"PNG"])
    store = FakeStore()
    fn = _build(backends={"a": backend}, backend_configs={"a": {"priority": 100}}, store=store)

    result: ToolResult = await fn(prompt="a cat", params={"quality": "ultra"}, ctx=_ctx())

    assert result.is_error
    assert backend.calls == 0
    assert "quality" in result.text
    assert "schema" in result.text.lower()
    assert store.records == []


async def test_naming_a_backend_makes_it_the_only_candidate_no_fallthrough():
    named = FakeBackend("a", result=[b"PNG"])
    other = FakeBackend("b", result=[b"PNG"])
    store = FakeStore()
    fn = _build(
        backends={"a": named, "b": other},
        backend_configs={"a": {"priority": 10}, "b": {"priority": 200}},
        store=store,
    )

    # "a" would never win on priority, but naming it pins it, and a params mismatch
    # on it is a hard error rather than a silent switch to "b".
    result: ToolResult = await fn(prompt="a cat", backend="a", params={"quality": "ultra"}, ctx=_ctx())

    assert result.is_error
    assert named.calls == 0
    assert other.calls == 0


async def test_an_unknown_or_disabled_backend_name_is_rejected_up_front():
    store = FakeStore()
    fn = _build(backends={"a": FakeBackend("a")}, backend_configs={"a": {"priority": 100}}, store=store)

    result: ToolResult = await fn(prompt="a cat", backend="nope", ctx=_ctx())

    assert result.is_error
    assert "nope" in result.text


async def test_every_candidate_over_its_cap_is_a_clean_error_not_a_crash():
    store = FakeStore()
    fn = _build(
        backends={"a": FakeBackend("a")},
        backend_configs={"a": {"priority": 100}},
        store=store,
        daily_limit=0,  # already at the total cap
    )

    result: ToolResult = await fn(prompt="a cat", ctx=_ctx())

    assert result.is_error
    assert "cap" in result.text.lower()


async def test_successful_generation_writes_each_image_and_records_one_usage_row(monkeypatch):
    backend = FakeBackend("a", result=[b"PNG-1", b"PNG-2"])
    store = FakeStore()
    fn = _build(backends={"a": backend}, backend_configs={"a": {"priority": 100}}, store=store)

    written = []

    async def fake_write_image(agent_host_url, conversation_id, name, data):
        written.append((name, data))
        return f"/workspace/images/{name}"

    monkeypatch.setattr(mcp_tools, "write_image", fake_write_image)

    result: ToolResult = await fn(prompt="a cat", n=2, ctx=_ctx())

    assert not result.is_error
    assert len(written) == 2
    assert written[0][1] == b"PNG-1" and written[1][1] == b"PNG-2"
    assert store.records == [("alice", "a", "m1")]


async def _ok_path(*args, **kwargs):
    return "/workspace/images/out.png"


def test_default_name_matches_the_image_format() -> None:
    assert mcp_tools._image_name(None, 0, 1, b"\xff\xd8\xff\xe0").endswith(".jpg")
    assert mcp_tools._image_name(None, 1, 2, b"\x89PNG\r\n").endswith("-1.png")
    assert mcp_tools._image_name("cat.png", 0, 1, b"\xff\xd8\xff\xe0") == "cat.png"
