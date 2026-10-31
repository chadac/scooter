"""GET /git/identity: the user authors only in their private conversation, the bot everywhere else."""

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
    "priv": {"owner": "alice", "visibility": "private"},
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


@pytest.mark.parametrize("conv", ["shared", "unknown"])
def test_the_bot_authors_everywhere_else(conv):
    assert client(conv).get("/git/identity").json() == {
        "author": {"name": BOT.name, "email": BOT.email},
        "co_author": None,
    }
