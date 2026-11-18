"""AWS role grants in the Approvals tab: listed, extended, pinned, revived and revoked."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.grants import Grants
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_aws.grants import AwsGrants
from scooter_contrib_aws.models import RequestStatus

from test_authz_gate import READ, FakeAuthorizer, _service

ALICE = ("user:alice@x", "approver", "aws_account:dev")


def as_(user: str, conversation: str = "c1", **kw) -> dict:
    return {"approver": {"id": user, "email": f"{user}@x"}, "conversation_ids": [conversation], **kw}


@pytest.fixture
async def svc(tmp_path):
    return await _service(tmp_path, FakeAuthorizer({ALICE}))


@pytest.fixture
async def http(svc):
    async def authed() -> Identity:
        return Identity(conversation_id="", namespace="ns", service_account="agent-host", is_approver=True)

    app = FastAPI()
    app.include_router(Grants(contrib="aws", source=AwsGrants(svc)).routes(Provider(name="aws", transports=[]), authed),
                       prefix="/aws")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://broker") as c:
        yield c


@pytest.fixture
async def granted(svc):
    req = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    return (await svc.approve(request_id=req.request_id, approver="alice@x")).request_id


async def listing(http, user: str = "alice") -> list[dict]:
    r = await http.post("/aws/grants/list", json=as_(user))
    assert r.status_code == 200, r.text
    return r.json()["grants"]


async def test_pending_requests_are_not_grants(svc, http):
    await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    assert await listing(http) == []


async def test_an_active_grant_lists_for_its_account_approvers(granted, http):
    [g] = await listing(http)
    assert g["id"] == granted and g["status"] == "active" and g["title"] == "AWS access to dev"
    assert g["granted_by"] == "alice@x" and "account dev" in g["scope"]
    assert [(v["verb"], v["allowed"]) for v in g["verbs"]] == [("extend", True), ("pin", True), ("revoke", True)]
    # role_ttl_hours caps presets at 12 hours.
    assert g["verbs"][0]["presets_minutes"] == [60, 240, 480, 720]
    assert not any(v["allowed"] for v in (await listing(http, "mallory"))[0]["verbs"])


async def test_extend_moves_the_role_ttl(granted, http, svc):
    before = (await svc.get(granted)).role_expires_at
    r = (await http.post(f"/aws/grants/{granted}/extend", json=as_("alice", minutes=60))).json()
    after = (await svc.get(granted)).role_expires_at
    assert datetime.fromisoformat(after) - datetime.fromisoformat(before) == pytest.approx(timedelta(hours=1), abs=timedelta(seconds=5))
    assert "extended your AWS access to dev" in r["agent_message"]
    assert (await http.post(f"/aws/grants/{granted}/extend", json=as_("alice", minutes=1440))).status_code == 400


async def test_a_pinned_role_survives_the_sweep_and_keeps_minting_short_creds(granted, http, svc):
    r = (await http.post(f"/aws/grants/{granted}/pin", json=as_("alice"))).json()
    assert r["grant"]["expires_at"] is None and "until revoked" in r["agent_message"]
    assert await svc.sweep_expired() == []
    req, creds = await svc.status(request_id=granted, conversation_id="c1")
    assert req.status == RequestStatus.ACTIVE and creds is not None


async def test_revoke_then_revive_provisions_a_linked_grant(granted, http, svc):
    r = (await http.post(f"/aws/grants/{granted}/revoke", json=as_("alice"))).json()
    assert r["grant"]["status"] == "revoked"
    r = (await http.post(f"/aws/grants/{granted}/revive", json=as_("alice", minutes=60))).json()
    new = r["grant"]
    assert new["id"] != granted and new["parent_id"] == granted and new["status"] == "active"
    assert "aws --profile dev" in r["agent_message"]
    req, creds = await svc.status(request_id=new["id"], conversation_id="c1")
    assert creds is not None
    end = datetime.fromisoformat(req.role_expires_at)
    assert end - datetime.now(timezone.utc) == pytest.approx(timedelta(hours=1), abs=timedelta(seconds=5))
    # The revived grant keeps the original's approvers.
    assert all(v["allowed"] for v in (await listing(http))[0]["verbs"])


async def test_mallory_cannot_act(granted, http):
    assert (await http.post(f"/aws/grants/{granted}/revoke", json=as_("mallory"))).status_code == 403


async def test_another_conversation_cannot_reach_the_grant(granted, http):
    assert (await http.post(f"/aws/grants/{granted}/revoke", json=as_("alice", "c2"))).status_code == 404


async def test_deleting_the_conversation_tears_down_pinned_roles(granted, http, svc):
    await http.post(f"/aws/grants/{granted}/pin", json=as_("alice"))
    r = await http.post("/aws/grants/revoke-conversation", json={"conversation_id": "c1"})
    assert r.json() == {"revoked": 1}
    assert (await svc.get(granted)).status == RequestStatus.REVOKED
