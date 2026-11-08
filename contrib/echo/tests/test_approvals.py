"""Echo's approval flow, driving the routes the agent-host relays to with nothing aws-shaped anywhere."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_broker_lib.types import Identity

from scooter_contrib_echo.approvals import EchoApprovals

CONV = "k3f9zq"  # the short id, the only handle the broker has on a conversation


def _client(transport: EchoApprovals) -> TestClient:
    """Mount the transport the way the broker core does, under /{provider.name}."""

    async def authed() -> Identity:
        return Identity(
            conversation_id=CONV,
            namespace="test",
            service_account=f"system:serviceaccount:test:sandbox-{CONV}",
        )

    class _P:
        name = "echo"

    app = FastAPI()
    app.include_router(transport.routes(_P(), authed=authed), prefix="/echo")
    return TestClient(app)


def _open_request(client: TestClient, message: str = "echo asks") -> str:
    res = client.post("/echo/approvals", json={"message": message})
    assert res.status_code == 201
    return res.json()["request_id"]


def test_routes_match_the_declared_broker_prefix():
    """The derived scooter.approvals.echo row (/echo/approvals) must reach real routes."""
    client = _client(EchoApprovals())
    rid = _open_request(client)
    assert client.get("/echo/approvals/pending", params={"conversation_id": CONV}).status_code == 200
    assert client.post(f"/echo/approvals/{rid}/can-approve", json={}).status_code == 200
    assert client.post(f"/echo/approvals/{rid}/approve", json={"approver": {"id": "u@x"}}).status_code == 200


def test_records_the_human_who_answered():
    """The recorded approver is the human, not the conversation."""
    client = _client(EchoApprovals())
    rid = _open_request(client)

    res = client.post(
        f"/echo/approvals/{rid}/approve",
        json={"approver": {"id": "sub-abc", "email": "alice@example.com"}},
    )
    assert res.status_code == 200
    assert res.json()["approver"] == "alice@example.com"
    assert res.json()["approver"] != CONV, "the conversation id is not a person"
    assert client.get(f"/echo/approvals/{rid}").json()["status"] == "approved"


def test_refuses_an_answer_that_carries_no_identity():
    """No approver is a 400, so a lost identity cannot pass quietly."""
    client = _client(EchoApprovals())
    rid = _open_request(client)
    res = client.post(f"/echo/approvals/{rid}/approve", json={})
    assert res.status_code == 400
    assert "approver" in str(res.json()["detail"]["errors"])
    assert client.get(f"/echo/approvals/{rid}").json()["status"] == "pending"


def test_the_verb_is_the_option_id():
    """The platform relays the chosen optionId as a path segment, so deny is a route rather than `approved=false`."""
    client = _client(EchoApprovals())
    rid = _open_request(client)
    res = client.post(f"/echo/approvals/{rid}/deny", json={"approver": {"id": "u@x"}})
    assert res.status_code == 200
    assert res.json()["answered"] == "deny"
    assert res.json()["status"] == "denied"


def test_rejects_an_unknown_verb():
    client = _client(EchoApprovals())
    rid = _open_request(client)
    res = client.post(f"/echo/approvals/{rid}/maybe", json={"approver": {"id": "u@x"}})
    assert res.status_code == 400


def test_pending_is_scoped_to_one_conversation_and_clears_when_answered():
    """What the revive re-raise reads; a leak across conversations would raise someone else's approval window."""
    transport = EchoApprovals()
    client = _client(transport)
    rid = _open_request(client)

    pending = client.get("/echo/approvals/pending", params={"conversation_id": CONV}).json()["requests"]
    assert [r["request_id"] for r in pending] == [rid]
    # The prose travels with the pending row, so a window rebuilt after a rollout is worded the same.
    assert pending[0]["message"] == "echo asks"

    assert client.get("/echo/approvals/pending", params={"conversation_id": "someone-else"}).json()["requests"] == []

    client.post(f"/echo/approvals/{rid}/approve", json={"approver": {"id": "u@x"}})
    assert client.get("/echo/approvals/pending", params={"conversation_id": CONV}).json()["requests"] == []


def test_pending_requires_a_conversation_id():
    """Without it the query would mean "everyone's pending approvals"."""
    assert _client(EchoApprovals()).get("/echo/approvals/pending").status_code == 400


def test_can_approve_is_per_viewer():
    """Per-viewer because one interrupt is seen by many."""
    transport = EchoApprovals()
    client = _client(transport)
    rid = _open_request(client)

    assert client.post(f"/echo/approvals/{rid}/can-approve", json={"approver": {"id": "u@x"}}).json() == {
        "can_approve": True
    }
    assert client.post(f"/echo/approvals/{rid}/can-approve", json={}).json() == {"can_approve": False}

    # The refusing case, without standing up OpenFGA.
    transport.deny_all = True
    assert client.post(f"/echo/approvals/{rid}/can-approve", json={"approver": {"id": "u@x"}}).json() == {
        "can_approve": False
    }


def test_a_second_answer_does_not_overwrite_the_first():
    """Two people racing: the first decision stands and the second gets a 409."""
    client = _client(EchoApprovals())
    rid = _open_request(client)
    client.post(f"/echo/approvals/{rid}/approve", json={"approver": {"id": "alice"}})
    res = client.post(f"/echo/approvals/{rid}/deny", json={"approver": {"id": "bob"}})
    assert res.status_code == 409
    assert client.get(f"/echo/approvals/{rid}").json()["approver"] == "alice"


def test_unknown_request_is_404_everywhere():
    client = _client(EchoApprovals())
    assert client.get("/echo/approvals/nope").status_code == 404
    assert client.post("/echo/approvals/nope/approve", json={"approver": {"id": "u"}}).status_code == 404
    assert client.post("/echo/approvals/nope/can-approve", json={}).status_code == 404
