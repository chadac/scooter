from __future__ import annotations

from scooter_contrib_handoff import index
from scooter_contrib_handoff.index import reindex


async def test_indexes_shared_conversations_only(store, agent_host, router):
    router.add("c1", title="Router 503s", messages=[("user", "router 503"), ("assistant", "no ready pod"), ("tool", "secret")])
    router.add("c2", visibility="private", messages=[("user", "router 503 private")])
    router.add("c3", parent="c1", messages=[("user", "router 503 subagent")])
    result = await reindex(store, agent_host)
    assert result["indexed"] == 1
    assert await store.indexed() == {"c1": 1000}
    assert [h.conversation_id for h in await store.search("router", 5)] == ["c1"]
    assert await store.search("secret", 5) == [], "tool output is never indexed"


async def test_reindexes_only_what_changed(store, agent_host, router):
    router.add("c1", at=1000, messages=[("user", "alpha")])
    await reindex(store, agent_host)
    assert (await reindex(store, agent_host))["indexed"] == 0
    router.add("c1", at=2000, messages=[("user", "beta")])
    assert (await reindex(store, agent_host))["indexed"] == 1
    assert await store.search("alpha", 5) == [] and await store.search("beta", 5) != []


async def test_a_conversation_made_private_leaves_the_index(store, agent_host, router):
    router.add("c1", messages=[("user", "alpha")])
    await reindex(store, agent_host)
    router.rows["c1"]["visibility"] = "private"
    assert (await reindex(store, agent_host))["removed"] == 1
    assert await store.indexed() == {}


async def test_a_backlog_spreads_over_passes(store, agent_host, router, monkeypatch):
    monkeypatch.setattr(index, "MAX_CONVERSATIONS", 2)
    for i in range(3):
        router.add(f"c{i}", at=1000 + i, messages=[("user", "x")])
    first = await reindex(store, agent_host)
    assert (first["indexed"], first["pending"]) == (2, 1)
    assert set(await store.indexed()) == {"c1", "c2"}, "newest first"
    assert (await reindex(store, agent_host))["indexed"] == 1
