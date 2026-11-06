from __future__ import annotations


async def test_search_ranks_one_hit_per_conversation(store):
    await store.replace_conversation("c1", title="Router 503s", owner="alice", visibility="shared", last_activity_at=10, messages=[
        ("user", "why does the router return 503 during deploys"),
        ("assistant", "the router 503 comes from no ready pod"),
    ])
    await store.replace_conversation("c2", title="Unrelated", owner="bob", visibility="shared", last_activity_at=20, messages=[
        ("user", "the router is fine"),
    ])
    hits = await store.search("router 503", 10)
    assert [h.conversation_id for h in hits] == ["c1"]
    assert "503" in hits[0].snippet and hits[0].title == "Router 503s"
    assert [h.conversation_id for h in await store.search("router", 10)] == ["c1", "c2"], "title match first"
    assert await store.search("router", 10, exclude={"c1", "c2"}) == []


async def test_replace_swaps_messages_and_remove_forgets(store):
    await store.replace_conversation("c1", title="t", owner=None, visibility="shared", last_activity_at=1, messages=[("user", "alpha")])
    await store.replace_conversation("c1", title="t", owner=None, visibility="shared", last_activity_at=2, messages=[("user", "beta")])
    assert await store.search("alpha", 5) == []
    assert await store.indexed("shared") == {"c1": 2}
    await store.remove_conversations(["c1"])
    assert await store.indexed("shared") == {} and await store.search("beta", 5) == []


async def test_a_private_conversation_is_searchable_only_by_its_owner(store):
    await store.replace_conversation("p1", title="mine", owner="alice", visibility="private", last_activity_at=1,
                                     messages=[("user", "router 503 secret")])
    assert [h.conversation_id for h in await store.search("router", 5, owner="alice")] == ["p1"]
    assert await store.search("router", 5, owner="bob") == []
    assert await store.search("router", 5) == [], "no owner means shared only"
    assert await store.indexed("private", "alice") == {"p1": 1}
    assert await store.indexed("private", "bob") == {} and await store.indexed("shared") == {}
