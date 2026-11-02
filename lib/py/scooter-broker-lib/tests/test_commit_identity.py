"""The acting user authors with the bot as co-author; otherwise the bot authors, crediting the owner."""

from __future__ import annotations

import pytest

from scooter_broker_lib import commit_identity as ci
from scooter_broker_lib.commit_identity import Person

BOT = Person("scooter[bot]", "1+scooter[bot]@users.noreply.github.com")
ALICE = Person("alice", "2+alice@users.noreply.github.com")


@pytest.fixture(autouse=True)
def _clean():
    saved = dict(ci._sources)
    ci._sources.clear()
    yield
    ci._sources.clear()
    ci._sources.update(saved)
    ci.provide_chosen(None)


def forge(people: dict):
    async def source(user):
        return people.get(user)

    return source


async def test_no_sources_means_no_identity():
    assert (await ci.resolve("alice")).payload() == {"author": None, "co_author": None}


async def test_not_acting_commits_as_the_bot():
    ci.register_commit_identity(forge({None: BOT, "alice": ALICE}))
    assert await ci.resolve(None) == ci.CommitIdentity(author=BOT)


async def test_acting_for_a_linked_user_credits_the_bot():
    ci.register_commit_identity(forge({None: BOT, "alice": ALICE}))
    got = await ci.resolve("alice")
    assert got == ci.CommitIdentity(author=ALICE, co_author=BOT)
    assert got.payload()["co_author"] == "scooter[bot] <1+scooter[bot]@users.noreply.github.com>"


async def test_acting_for_an_unlinked_user_commits_as_the_bot():
    ci.register_commit_identity(forge({None: BOT}))
    assert await ci.resolve("bob") == ci.CommitIdentity(author=BOT)


async def test_a_failing_source_falls_through_to_the_next():
    @ci.register_commit_identity
    async def broken(user):
        raise RuntimeError("forge down")

    ci.register_commit_identity(forge({None: BOT, "alice": ALICE}))
    assert await ci.resolve("alice") == ci.CommitIdentity(author=ALICE, co_author=BOT)


def chosen(people: dict):
    async def lookup(user):
        return people.get(user)

    return lookup


async def test_a_chosen_identity_wins_over_the_forge_account():
    ci.register_commit_identity(forge({None: BOT, "alice": ALICE}))
    mine = Person("Alice Liddell", "alice@example.com")
    ci.provide_chosen(chosen({"alice": mine}))
    assert await ci.resolve("alice") == ci.CommitIdentity(author=mine, co_author=BOT)


async def test_a_chosen_identity_needs_no_linked_forge_account():
    ci.register_commit_identity(forge({None: BOT}))
    mine = Person("Bob", "bob@example.com")
    ci.provide_chosen(chosen({"bob": mine}))
    assert await ci.resolve("bob") == ci.CommitIdentity(author=mine, co_author=BOT)


async def test_a_chosen_identity_never_applies_when_not_acting():
    ci.register_commit_identity(forge({None: BOT}))
    ci.provide_chosen(chosen({None: ALICE}))
    assert await ci.resolve(None) == ci.CommitIdentity(author=BOT)


async def test_a_failing_lookup_falls_back_to_the_forge_account():
    ci.register_commit_identity(forge({None: BOT, "alice": ALICE}))

    async def broken(user):
        raise RuntimeError("db down")

    ci.provide_chosen(broken)
    assert await ci.resolve("alice") == ci.CommitIdentity(author=ALICE, co_author=BOT)


async def test_not_acting_credits_the_owner():
    ci.register_commit_identity(forge({None: BOT, "alice": ALICE}))
    assert await ci.resolve(None, owner="alice") == ci.CommitIdentity(author=BOT, co_author=ALICE)


async def test_not_acting_credits_the_owners_chosen_identity():
    ci.register_commit_identity(forge({None: BOT, "alice": ALICE}))
    mine = Person("Alice Liddell", "alice@example.com")
    ci.provide_chosen(chosen({"alice": mine}))
    got = await ci.resolve(None, owner="alice")
    assert got == ci.CommitIdentity(author=BOT, co_author=mine)
    assert got.payload()["co_author"] == "Alice Liddell <alice@example.com>"


async def test_an_owner_without_an_identity_is_not_credited():
    ci.register_commit_identity(forge({None: BOT}))
    assert await ci.resolve(None, owner="bob") == ci.CommitIdentity(author=BOT)
