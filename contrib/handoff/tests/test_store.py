from __future__ import annotations


async def test_search_ranks_one_hit_per_conversation(store):
    await store.replace_conversation("c1", title="Router 503s", owner="alice", last_activity_at=10, messages=[
        ("user", "why does the router return 503 during deploys"),
        ("assistant", "the router 503 comes from no ready pod"),
    ])
    await store.replace_conversation("c2", title="Unrelated", owner="bob", last_activity_at=20, messages=[
        ("user", "the router is fine"),
    ])
    hits = await store.search("router 503", 10)
    assert [h.conversation_id for h in hits] == ["c1"]
    assert "503" in hits[0].snippet and hits[0].title == "Router 503s"
    assert [h.conversation_id for h in await store.search("router", 10)] == ["c1", "c2"], "title match first"
    assert await store.search("router", 10, exclude={"c1", "c2"}) == []


async def test_replace_swaps_messages_and_remove_forgets(store):
    await store.replace_conversation("c1", title="t", owner=None, last_activity_at=1, messages=[("user", "alpha")])
    await store.replace_conversation("c1", title="t", owner=None, last_activity_at=2, messages=[("user", "beta")])
    assert await store.search("alpha", 5) == []
    assert await store.indexed() == {"c1": 2}
    await store.remove_conversations(["c1"])
    assert await store.indexed() == {} and await store.search("beta", 5) == []
