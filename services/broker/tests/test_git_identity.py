"""GET /git/identity: the owner authors their private conversation; elsewhere the bot authors, crediting the owner."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import broker.core.app as app_mod
from broker.core.app import create_app
from broker.core.auth import authenticate
from scooter_broker_lib import commit_identity as ci
from scooter_broker_lib.commit_identity import Person
from scooter_broker_lib.types import Identity

VIEWS = {
    "priv": {"owner": "alice", "visibility": "private", "authors": []},
    "shared": {"owner": "alice", "visibility": "shared"},
}
BOT = Person("scooter[bot]", "1+scooter[bot]@users.noreply.github.com")
ALICE = Person("alice", "2+alice@users.noreply.github.com")


@pytest.fixture(autouse=True)
def forge(monkeypatch):
    def fetcher(_url):
        async def fetch(conv):
            return VIEWS.get(conv)

        return fetch

    monkeypatch.setattr(app_mod, "agent_host_fetcher", fetcher)
    saved = dict(ci._sources)

    @ci.register_commit_identity
    async def source(user):
        return {None: BOT, "alice": ALICE}.get(user)

    yield
    ci._sources.clear()
    ci._sources.update(saved)


def client(conv: str) -> TestClient:
    app = create_app()
    app.dependency_overrides[authenticate] = lambda: Identity(
        conversation_id=conv, namespace="ns", service_account=f"sandbox-{conv}"
    )
    return TestClient(app)


def test_the_owner_authors_in_their_private_conversation():
    assert client("priv").get("/git/identity").json() == {
        "author": {"name": "alice", "email": ALICE.email},
        "co_author": BOT.ident(),
    }


def test_the_bot_authors_a_shared_conversation_crediting_the_owner():
    assert client("shared").get("/git/identity").json() == {
        "author": {"name": BOT.name, "email": BOT.email},
        "co_author": ALICE.ident(),
    }


def test_the_bot_authors_alone_in_an_unknown_conversation():
    assert client("unknown").get("/git/identity").json() == {
        "author": {"name": BOT.name, "email": BOT.email},
        "co_author": None,
    }
