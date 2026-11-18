"""Workspace access: the first call asks the owner, approving stores a grant, and the Approvals tab manages it."""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.forge.policy import ForgeRequest
from scooter_broker_lib.grants import Grants
from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.store import StoreConfig
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_databricks.grants import DatabricksGrants, GrantPolicy, grant_approvals, level_of
from scooter_contrib_databricks.store import READ, WRITE, GrantStore, _Base
from scooter_schema.broker import Base

MINUTES = 240
KEYS = {"conversation_ids": ["conv"]}
VIEWS = {"conv": {"owner": "alice", "visibility": "shared"}, "ownerless": {"owner": "", "visibility": "shared"}}


@dataclass
class FakeCards:
    raised: list[dict] = field(default_factory=list)

    async def raise_(self, conversation_id, contrib, card):
        self.raised.append(card)

    async def withdraw(self, conversation_id, contrib, request_id):
        return None


async def _view(cid):
    return VIEWS.get(cid)


def as_(user: str, **kw) -> dict:
    return {"approver": {"id": user, "email": f"{user}@example.com"}, **KEYS, **kw}


def req(method: str = "GET", conversation: str = "conv") -> ForgeRequest:
    return ForgeRequest(identity=Identity(conversation_id=conversation, namespace="ns", service_account="sa"),
                        provider="databricks-prod", via="forge-proxy", method=method,
                        host="prod.cloud.databricks.com", path="/api/2.0/clusters/list", kind="api")


@pytest.fixture
def cards():
    return FakeCards()


@pytest.fixture
async def wired(cards, tmp_path):
    # A file, so a second GrantStore stands in for a restarted broker.
    store = GrantStore(StoreConfig(dsn=f"sqlite+aiosqlite:///{tmp_path}/grants.db"))
    await create_schema(store, _Base)
    approvals = grant_approvals(store, MINUTES)
    approvals.configure(sqlite_config(), cards)
    await create_schema(approvals, Base)
    policy = GrantPolicy("prod", store, approvals, OwnerResolver(_view, ttl=0))
    return store, approvals, policy


@pytest.fixture
async def http(wired):
    store, approvals, _ = wired
    app = FastAPI()

    async def authed() -> Identity:
        return Identity(conversation_id="", namespace="ns", service_account="agent-host", is_approver=True)

    p = Provider(name="databricks", transports=[])
    app.include_router(approvals.routes(p, authed), prefix="/databricks")
    grants = Grants(contrib="databricks", source=DatabricksGrants(store, approvals, MINUTES))
    app.include_router(grants.routes(p, authed), prefix="/databricks")
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://broker") as c:
        yield c


async def approve_first(wired, http, method="GET") -> str:
    _, approvals, policy = wired
    assert not (await policy.check(req(method))).allowed
    [pending] = await approvals.pending(conversation_id="conv")
    r = (await http.post(f"/databricks/approvals/{pending.id}/approve", json=as_("alice"))).json()
    return r["grant_id"]


def test_levels():
    assert (level_of("GET"), level_of("head"), level_of("POST")) == (READ, READ, WRITE)


async def test_first_call_asks_once_then_waits(wired, cards):
    _, _, policy = wired
    d1, d2 = await policy.check(req()), await policy.check(req())
    assert not d1.allowed and not d2.allowed and "waiting" in d1.reason
    assert len(cards.raised) == 1 and cards.raised[0]["data"]["level"] == READ


async def test_a_read_grant_allows_reads_and_asks_again_for_a_write(wired, http, cards):
    _, _, policy = wired
    await approve_first(wired, http)
    assert (await policy.check(req("GET"))).allowed
    assert not (await policy.check(req("POST"))).allowed
    assert cards.raised[-1]["data"]["level"] == WRITE


async def test_a_grant_outlives_the_broker(wired, http, tmp_path):
    _, approvals, _ = wired
    await approve_first(wired, http, "POST")
    restarted = GrantStore(StoreConfig(dsn=f"sqlite+aiosqlite:///{tmp_path}/grants.db"))
    policy = GrantPolicy("prod", restarted, approvals, OwnerResolver(_view, ttl=0))
    assert (await policy.check(req("GET"))).allowed and (await policy.check(req("POST"))).allowed


async def test_a_grant_is_one_workspace_and_one_conversation(wired, http):
    store, approvals, _ = wired
    await approve_first(wired, http)
    assert not await store.allows("conv", "dev", READ)
    assert not await store.allows("other", "prod", READ)


async def test_no_owner_no_card(wired, cards):
    _, _, policy = wired
    d = await policy.check(req(conversation="ownerless"))
    assert not d.allowed and "no owner" in d.reason and cards.raised == []


async def test_the_approvals_tab_lists_and_revokes_it(wired, http):
    _, _, policy = wired
    gid = await approve_first(wired, http)
    [g] = (await http.post("/databricks/grants/list", json=as_("alice"))).json()["grants"]
    assert (g["id"], g["status"], g["title"]) == (gid, "active", "Read prod")
    assert [(v["verb"], v["allowed"]) for v in g["verbs"]] == [("extend", True), ("pin", True), ("revoke", True)]
    assert g["verbs"][0]["presets_minutes"] == [15, 30, 60, 240]

    assert (await http.post(f"/databricks/grants/{gid}/revoke", json=as_("mallory"))).status_code == 403
    r = (await http.post(f"/databricks/grants/{gid}/revoke", json=as_("alice"))).json()
    assert r["grant"]["status"] == "revoked" and "revoked your read access to Databricks prod" in r["agent_message"]
    assert not (await policy.check(req())).allowed


async def test_revive_renews_a_revoked_grant(wired, http):
    _, _, policy = wired
    gid = await approve_first(wired, http)
    await http.post(f"/databricks/grants/{gid}/revoke", json=as_("alice"))
    r = (await http.post(f"/databricks/grants/{gid}/revive", json=as_("alice", minutes=15))).json()
    assert r["grant"]["parent_id"] == gid and r["grant"]["status"] == "active"
    assert (await policy.check(req())).allowed


async def test_deleting_the_conversation_revokes_its_grants(wired, http):
    _, _, policy = wired
    await approve_first(wired, http)
    assert (await http.post("/databricks/grants/revoke-conversation", json={"conversation_id": "conv"})).json() == {
        "revoked": 1}
    assert not (await policy.check(req())).allowed
