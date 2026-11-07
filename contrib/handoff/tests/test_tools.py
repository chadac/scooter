"""handoff's agent tools against a fake router."""

from __future__ import annotations

import json

import pytest
from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.types import Identity, Provider

from scooter_contrib_handoff import mcp_tools, spawn
from scooter_contrib_handoff.index import reindex
from scooter_contrib_handoff.mcp_tools import handoff_read, handoff_search, handoff_spawn


@pytest.fixture
def links(store, agent_host, owners, monkeypatch):
    mcp_tools.configure(store, agent_host, "https://scooter.test", owners=owners, require_approval=False)
    posted: list[tuple[str, object]] = []

    async def post_link(url, conversation_id, link):
        posted.append((conversation_id, link))

    monkeypatch.setattr(spawn, "post_link", post_link)
    return posted


def ctx(conversation: str) -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id=conversation, namespace="ns", service_account="agent-host", owner="alice"),
        provider=Provider(name="handoff", transports=[]),
        upstream=None,  # type: ignore[arg-type]
        links=None,  # type: ignore[arg-type]
    )


async def test_spawn_sends_the_brief_from_the_calling_conversation(router, links):
    router.add("src", title="Source")
    r = await handoff_spawn(brief="  Finish the migration.  ", title="Migration", ctx=ctx("src"))
    assert not r.is_error, r.text
    out = json.loads(r.text)
    assert out == {"conversation_id": "new-1", "url": "https://scooter.test/?thread=new-1", "visibility": "shared"}
    source_id, body = router.spawns[0]
    assert source_id == "src" and body["title"] == "Migration" and body["source"] == "handoff"
    assert body["prompt"].startswith("Finish the migration.\n\n---\n")
    assert 'handoff_read(conversation_id="src")' in body["prompt"]
    assert [(cid, link.url) for cid, link in links] == [
        ("src", "https://scooter.test/?thread=new-1"), ("new-1", "https://scooter.test/?thread=src"),
    ]


async def test_a_private_source_still_gets_a_read_hint(router, links):
    router.add("src", visibility="private")
    r = await handoff_spawn(brief="go", ctx=ctx("src"))
    assert not r.is_error
    assert 'handoff_read(conversation_id="src")' in router.spawns[0][1]["prompt"], "the same owner can read it"


async def test_router_refusal_is_reported_with_any_created_id(router, links):
    router.add("src")
    router.spawn_status = 429
    r = await handoff_spawn(brief="go", ctx=ctx("src"))
    assert r.is_error and "429" in r.text and "half-made" in r.text and links == []


async def test_spawn_needs_a_brief(router, links):
    r = await handoff_spawn(brief="   ", ctx=ctx("src"))
    assert r.is_error and router.spawns == []


async def test_search_hides_this_conversation_and_newly_private_ones(router, links, store, agent_host):
    for cid in ("here", "other"):
        router.add(cid, title=cid, messages=[("user", "the router 503 bug")])
    router.add("gone", owner="bob", messages=[("user", "the router 503 bug")])
    await reindex(store, agent_host)
    router.rows["gone"]["visibility"] = "private"
    r = await handoff_search(query="router 503", ctx=ctx("here"))
    hits = json.loads(r.text)
    assert [h["conversation_id"] for h in hits] == ["other"]
    assert hits[0]["url"] == "https://scooter.test/?thread=other"


async def test_read_returns_text_messages_and_refuses_private(router, links):
    router.add("c1", title="T", messages=[("user", "q"), ("assistant", "a" * 3000), ("tool", "raw")])
    router.add("c2", visibility="private")
    out = json.loads((await handoff_read(conversation_id="c1", ctx=ctx("x"))).text)
    assert [m["role"] for m in out["messages"]] == ["user", "assistant"]
    assert out["messages"][1]["text"].endswith(" …") and out["next_before"] is None and out["title"] == "T"
    r = await handoff_read(conversation_id="c2", ctx=ctx("x"))
    assert r.is_error and "private" in r.text


async def test_search_finds_own_private_conversations_but_not_others(router, links):
    router.add("here", visibility="private")
    router.add("mine", title="mine", visibility="private", messages=[("user", "router 503 in staging")])
    router.add("bobs", owner="bob", visibility="private", messages=[("user", "router 503 for bob")])
    hits = json.loads((await handoff_search(query="router 503", ctx=ctx("here"))).text)
    assert [h["conversation_id"] for h in hits] == ["mine"]


async def test_search_is_shared_only_without_owned_reads(router, links, store, agent_host):
    router.owned_enabled = False
    router.add("here")
    router.add("shared", messages=[("user", "router 503")])
    router.add("mine", visibility="private", messages=[("user", "router 503")])
    await reindex(store, agent_host)
    hits = json.loads((await handoff_search(query="router 503", ctx=ctx("here"))).text)
    assert [h["conversation_id"] for h in hits] == ["shared"]


async def test_read_reaches_own_private_conversations_only(router, links):
    router.add("here", visibility="private")
    router.add("mine", title="Mine", visibility="private", messages=[("user", "q"), ("assistant", "a")])
    router.add("bobs", owner="bob", visibility="private", messages=[("user", "secret")])
    out = json.loads((await handoff_read(conversation_id="mine", ctx=ctx("here"))).text)
    assert [m["text"] for m in out["messages"]] == ["q", "a"] and out["title"] == "Mine"
    r = await handoff_read(conversation_id="bobs", ctx=ctx("here"))
    assert r.is_error and "private" in r.text


async def test_a_shared_conversation_reaches_none_of_its_owners_private_ones(router, links):
    router.add("here")
    router.add("mine", visibility="private", messages=[("user", "router 503")])
    assert (await handoff_search(query="router 503", ctx=ctx("here"))).text == "No conversation matches."
    assert (await handoff_read(conversation_id="mine", ctx=ctx("here"))).is_error


async def test_a_private_conversation_with_another_author_reads_only_shared_ones(router, links, store, agent_host):
    router.add("here", visibility="private", authors=("alice", None))
    router.add("shared", messages=[("user", "router 503")])
    router.add("mine", visibility="private", messages=[("user", "router 503")])
    await reindex(store, agent_host)
    hits = json.loads((await handoff_search(query="router 503", ctx=ctx("here"))).text)
    assert [h["conversation_id"] for h in hits] == ["shared"]
    assert (await handoff_read(conversation_id="mine", ctx=ctx("here"))).is_error


async def test_a_private_conversation_with_another_author_cannot_spawn(router, links):
    router.add("src", visibility="private", authors=("alice", "bob"))
    r = await handoff_spawn(brief="go", ctx=ctx("src"))
    assert r.is_error and "didn't write" in r.text and router.spawns == []


async def test_spawn_refuses_an_unknown_source(router, links):
    r = await handoff_spawn(brief="go", ctx=ctx("nowhere"))
    assert r.is_error and router.spawns == []


async def test_spawn_without_approval_files_at_once(router, links):
    router.add("src")
    r = await handoff_spawn(brief="go", folder="f-design", ctx=ctx("src"))
    assert not r.is_error, r.text
    assert json.loads(r.text)["filed"] is True and router.filed == [("alice", "new-1", "f-design")]
