"""The user authors (bot co-authors) only when acting for a linked user; otherwise the bot authors alone."""

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
