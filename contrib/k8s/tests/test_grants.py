"""Grants as the Approvals tab sees them: listed, extended, pinned, revived and revoked."""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.grants import Grants
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_k8s.grants import K8sGrants
from scooter_contrib_k8s.mcp_tools import k8s_delete, k8s_grants, k8s_request_grant

from conftest import ctx, who

KEYS = {"conversation_ids": ["conv"]}


def as_(user: str, **kw) -> dict:
    return {**who(user), **KEYS, **kw}


@pytest.fixture
async def grants(configured, app):
    configs = {name: c.config for name, c in configured.clusters.items()}
    source = K8sGrants(configured.grants, configured.approvals, configs)

    async def authed() -> Identity:
        return Identity(conversation_id="", namespace="ns", service_account="agent-host", is_approver=True)

    app.include_router(Grants(contrib="k8s", source=source).routes(Provider(name="k8s", transports=[]), authed),
                       prefix="/k8s")
    return source


@pytest.fixture
async def granted(grants, http):
    out = json.loads((await k8s_request_grant("default", 20, "the cache fix", cluster="home", ctx=ctx())).text)
    r = (await http.post(f"/k8s/approvals/{out['request_id']}/approve", json=who("alice"))).json()
    return r["grant_id"]


async def listing(http, user: str = "alice") -> list[dict]:
    r = await http.post("/k8s/grants/list", json=as_(user))
    assert r.status_code == 200, r.text
    return r.json()["grants"]


async def test_an_active_grant_lists_with_its_verbs(granted, http):
    [g] = await listing(http)
    assert g["id"] == granted and g["status"] == "active" and g["granted_by"] == "alice"
    assert g["title"] == "Write to home/default"
    # home caps grants at 30 minutes.
    assert [(v["verb"], v["presets_minutes"], v["allowed"]) for v in g["verbs"]] == [
        ("extend", [15, 30], True), ("pin", [], True), ("revoke", [], True),
    ]
    assert "conversation_id" not in g


async def test_only_who_could_approve_the_original_may_act(granted, http):
    [g] = await listing(http, "mallory")
    assert not any(v["allowed"] for v in g["verbs"])
    r = await http.post(f"/k8s/grants/{granted}/revoke", json=as_("mallory"))
    assert r.status_code == 403


async def test_extend_adds_to_the_current_end_within_the_cap(granted, http):
    [before] = await listing(http)
    r = (await http.post(f"/k8s/grants/{granted}/extend", json=as_("alice", minutes=30))).json()
    assert r["grant"]["expires_at"] == before["expires_at"] + 30 * 60_000
    assert "extended your write grant on home/default" in r["agent_message"]
    too_long = await http.post(f"/k8s/grants/{granted}/extend", json=as_("alice", minutes=60))
    assert too_long.status_code == 400


async def test_pin_lasts_until_revoked_and_still_covers_writes(granted, http, cards):
    r = (await http.post(f"/k8s/grants/{granted}/pin", json=as_("alice"))).json()
    assert r["grant"]["expires_at"] is None and "until revoked" in r["agent_message"]
    assert [v["verb"] for v in r["grant"]["verbs"]] == ["revoke"]
    out = json.loads((await k8s_delete("deploy", "web", cluster="home", ctx=ctx())).text)
    assert out["status"] == "done" and cards.raised[-1]["data"]["verb"] == "grant"
    assert json.loads((await k8s_grants(ctx=ctx())).text)[0]["expires_at"] == "until revoked"


async def test_revoke_ends_it_and_revive_issues_a_linked_grant(granted, http):
    r = (await http.post(f"/k8s/grants/{granted}/revoke", json=as_("alice"))).json()
    assert r["grant"]["status"] == "revoked" and r["grant"]["ended_by"] == "alice"
    out = json.loads((await k8s_delete("deploy", "web", cluster="home", ctx=ctx())).text)
    assert out["status"] == "pending_approval"

    [old] = await listing(http)
    assert [v["verb"] for v in old["verbs"]] == ["revive"]
    r = (await http.post(f"/k8s/grants/{granted}/revive", json=as_("alice", minutes=15))).json()
    new = r["grant"]
    assert new["id"] != granted and new["parent_id"] == granted and new["status"] == "active"
    assert "renewed" in r["agent_message"]
    assert [g["id"] for g in await listing(http)] == [new["id"], granted]
    # A revived grant keeps the original approvers.
    assert all(v["allowed"] for v in (await listing(http))[0]["verbs"])


async def test_a_verb_the_grant_does_not_offer_is_refused(granted, http):
    assert (await http.post(f"/k8s/grants/{granted}/revive", json=as_("alice", minutes=15))).status_code == 409
    await http.post(f"/k8s/grants/{granted}/revoke", json=as_("alice"))
    assert (await http.post(f"/k8s/grants/{granted}/extend", json=as_("alice", minutes=15))).status_code == 409


async def test_another_conversations_grant_is_out_of_reach(granted, http):
    r = await http.post(f"/k8s/grants/{granted}/revoke", json={**who("alice"), "conversation_ids": ["other"]})
    assert r.status_code == 404
    assert (await http.post("/k8s/grants/list", json={**who("alice"), "conversation_ids": ["other"]})).json() == {
        "grants": []}


async def test_deleting_the_conversation_revokes_even_pinned_grants(granted, http):
    await http.post(f"/k8s/grants/{granted}/pin", json=as_("alice"))
    assert (await http.post("/k8s/grants/revoke-conversation", json={"conversation_id": "conv"})).json() == {
        "revoked": 1}
    [g] = await listing(http)
    assert g["status"] == "revoked" and g["ended_by"] == "conversation deleted"
