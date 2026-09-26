"""Echo's approval flow — the SECOND consumer of the approval seam.

aws was the only integration that ever raised an approval, so "the mechanism" and
"what aws needs" were the same code, and the path could only be exercised by mocking
STS, IAM and OpenFGA. These tests drive the same routes the agent-host relays to,
with nothing aws-shaped anywhere, which is the actual claim the seam makes.

The assertion that matters most is `test_records_the_human_who_answered`: it is the
one PR #649 would have failed. Every piece of that path had unit coverage and the
identity still never arrived.
"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_broker_lib.types import Identity

from scooter_contrib_echo.approvals import EchoApprovals

CONV = "k3f9zq"  # the SHORT id — the only handle the broker has on a conversation


def _client(transport: EchoApprovals) -> TestClient:
    """Mount the transport the way broker core does: under /{provider.name}."""

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
    res = client.post("/echo/approval", json={"message": message})
    assert res.status_code == 201
    return res.json()["request_id"]


def test_routes_match_the_declared_broker_prefix():
    """The paths the agent-host builds from contrib/echo/default.nix must exist.

    `brokerPrefix = "/echo/approval"` + `/{request_id}/{optionId}`, and
    `pendingPath = "/echo/approval/pending"`. A declaration that disagrees with the
    routes is a 404 at answer time — after a human has already clicked Approve.
    """
    client = _client(EchoApprovals())
    rid = _open_request(client)
    assert client.get("/echo/approval/pending", params={"conversation_id": CONV}).status_code == 200
    assert client.post(f"/echo/approval/{rid}/can-approve", json={}).status_code == 200
    assert client.post(f"/echo/approval/{rid}/approve", json={"approver": {"id": "u@x"}}).status_code == 200


def test_records_the_human_who_answered():
    """WHO approved is the human, not the conversation.

    The bug this pins (PR #649): the agent-host relayed `{id: <conversationId>}`
    because the answering user's identity was dropped on the /agui resume path. With
    FGA on that principal matches no tuple; with FGA off it was recorded as the
    approver and the audit trail named nobody.
    """
    client = _client(EchoApprovals())
    rid = _open_request(client)

    res = client.post(
        f"/echo/approval/{rid}/approve",
        json={"approver": {"id": "sub-abc", "email": "alice@example.com"}},
    )
    assert res.status_code == 200
    assert res.json()["approver"] == "alice@example.com"
    assert res.json()["approver"] != CONV, "the conversation id is not a person"
    assert client.get(f"/echo/approval/{rid}").json()["status"] == "approved"


def test_refuses_an_answer_that_carries_no_identity():
    """No approver -> 400, loudly. The fixture's job is to FAIL when the identity is
    lost, so an e2e regression of #649 cannot pass quietly."""
    client = _client(EchoApprovals())
    rid = _open_request(client)
    res = client.post(f"/echo/approval/{rid}/approve", json={})
    assert res.status_code == 400
    assert "approver" in str(res.json()["detail"]["errors"])
    assert client.get(f"/echo/approval/{rid}").json()["status"] == "pending"


def test_the_verb_is_the_option_id():
    """The platform relays the chosen optionId as a path segment and does not
    interpret it, so deny is a route rather than `approved=false`."""
    client = _client(EchoApprovals())
    rid = _open_request(client)
    res = client.post(f"/echo/approval/{rid}/deny", json={"approver": {"id": "u@x"}})
    assert res.status_code == 200
    assert res.json()["answered"] == "deny"
    assert res.json()["status"] == "denied"


def test_rejects_an_unknown_verb():
    client = _client(EchoApprovals())
    rid = _open_request(client)
    res = client.post(f"/echo/approval/{rid}/maybe", json={"approver": {"id": "u@x"}})
    assert res.status_code == 400


def test_pending_is_scoped_to_one_conversation_and_clears_when_answered():
    """What the revive re-raise reads. A request that leaked across conversations would
    raise someone else's approval window in your chat."""
    transport = EchoApprovals()
    client = _client(transport)
    rid = _open_request(client)

    pending = client.get("/echo/approval/pending", params={"conversation_id": CONV}).json()["requests"]
    assert [r["request_id"] for r in pending] == [rid]
    # The prose travels WITH the pending row, so a window rebuilt after a rollout is
    # worded exactly like the one the user lost.
    assert pending[0]["message"] == "echo asks"

    assert client.get("/echo/approval/pending", params={"conversation_id": "someone-else"}).json()["requests"] == []

    client.post(f"/echo/approval/{rid}/approve", json={"approver": {"id": "u@x"}})
    assert client.get("/echo/approval/pending", params={"conversation_id": CONV}).json()["requests"] == []


def test_pending_requires_a_conversation_id():
    """Without it the query would mean "everyone's pending approvals"."""
    assert _client(EchoApprovals()).get("/echo/approval/pending").status_code == 400


def test_can_approve_is_per_viewer():
    """Powers the greyed option. Per-viewer because one interrupt is seen by many."""
    transport = EchoApprovals()
    client = _client(transport)
    rid = _open_request(client)

    assert client.post(f"/echo/approval/{rid}/can-approve", json={"approver": {"id": "u@x"}}).json() == {
        "can_approve": True
    }
    # Anonymous: nothing to authorize.
    assert client.post(f"/echo/approval/{rid}/can-approve", json={}).json() == {"can_approve": False}

    # The refusing case, without standing up OpenFGA — this is what makes the UI's
    # greyed-option path reachable in an end-to-end test.
    transport.deny_all = True
    assert client.post(f"/echo/approval/{rid}/can-approve", json={"approver": {"id": "u@x"}}).json() == {
        "can_approve": False
    }


def test_a_second_answer_does_not_overwrite_the_first():
    """Two people racing: the first decision stands, and the second gets a 409 rather
    than silently replacing a recorded security decision."""
    client = _client(EchoApprovals())
    rid = _open_request(client)
    client.post(f"/echo/approval/{rid}/approve", json={"approver": {"id": "alice"}})
    res = client.post(f"/echo/approval/{rid}/deny", json={"approver": {"id": "bob"}})
    assert res.status_code == 409
    assert client.get(f"/echo/approval/{rid}").json()["approver"] == "alice"


def test_unknown_request_is_404_everywhere():
    client = _client(EchoApprovals())
    assert client.get("/echo/approval/nope").status_code == 404
    assert client.post("/echo/approval/nope/approve", json={"approver": {"id": "u"}}).status_code == 404
    assert client.post("/echo/approval/nope/can-approve", json={}).status_code == 404
