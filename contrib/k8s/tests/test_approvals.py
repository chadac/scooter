"""Writes, exec and reveals wait for a person, and Approve runs exactly what was asked."""

from __future__ import annotations

import json

import pytest

from scooter_contrib_k8s.kube import K8sError
from scooter_contrib_k8s.mcp_tools import (
    k8s_apply, k8s_delete, k8s_exec, k8s_grants, k8s_request_grant, k8s_rollout_restart, k8s_scale,
    k8s_secret_reveal,
)

from conftest import ctx, who

CM = """
apiVersion: v1
kind: ConfigMap
metadata: {name: settings}
data: {mode: fast}
"""
SECRET = """
apiVersion: v1
kind: Secret
metadata: {name: db}
data: {password: bmV3cGFzcw==}
"""
NAMESPACE = """
apiVersion: v1
kind: Namespace
metadata: {name: team}
"""


def pending(r) -> str:
    assert not r.is_error, r.text
    out = json.loads(r.text)
    assert out["status"] == "pending_approval", out
    return out["request_id"]


async def test_apply_waits_then_runs_on_approve(configured, kube, cards, http):
    rid = pending(await k8s_apply(CM, cluster="home", ctx=ctx()))
    assert kube.calls == [("apply", True)] and ("ConfigMap", "default", "settings") not in kube.objects
    message = cards.raised[0]["message"]
    assert "apply 1 object on cluster home" in message and "ConfigMap default/settings: created" in message
    assert "+  mode: fast" in message

    r = (await http.post(f"/k8s/approvals/{rid}/approve", json=who("alice"))).json()
    assert r["status"] == "approve", r
    assert "ConfigMap default/settings: applied" in r["agent_message"]
    assert kube.objects[("ConfigMap", "default", "settings")]["data"] == {"mode": "fast"}


async def test_deny_runs_nothing(configured, kube, http):
    rid = pending(await k8s_delete("deploy", "web", cluster="home", ctx=ctx()))
    r = (await http.post(f"/k8s/approvals/{rid}/deny", json=who("alice"))).json()
    assert "denied" in r["agent_message"] and ("Deployment", "default", "web") in kube.objects
    assert kube.calls == [("delete", True)]


async def test_a_failing_dry_run_raises_no_card(configured, kube, cards):
    kube.dry_run_error = K8sError('422 ConfigMap "settings" is invalid', 422)
    r = await k8s_apply(CM, cluster="home", ctx=ctx())
    assert r.is_error and "422" in r.text and cards.raised == []


async def test_apply_card_hides_secret_values(configured, cards, http, kube):
    rid = pending(await k8s_apply(SECRET, cluster="home", ctx=ctx()))
    message = cards.raised[0]["message"]
    assert "Secret default/db: changed" in message and "sha256" in message
    for leak in ("bmV3cGFzcw", "newpass", "aHVudGVyMg", "hunter2"):
        assert leak not in message
    r = (await http.post(f"/k8s/approvals/{rid}/approve", json=who("alice"))).json()
    assert "bmV3cGFzcw" not in r["agent_message"]


async def test_scale_restart_and_exec(configured, kube, cards, http):
    rid = pending(await k8s_scale("deploy", "web", 5, cluster="home", ctx=ctx()))
    assert "Replicas: 2 → 5" in cards.raised[-1]["message"]
    await http.post(f"/k8s/approvals/{rid}/approve", json=who("alice"))
    assert kube.objects[("Deployment", "default", "web")]["spec"]["replicas"] == 5

    rid = pending(await k8s_rollout_restart("deploy", "web", cluster="home", ctx=ctx()))
    await http.post(f"/k8s/approvals/{rid}/approve", json=who("alice"))
    template = kube.objects[("Deployment", "default", "web")]["spec"]["template"]
    assert "kubectl.kubernetes.io/restartedAt" in template["metadata"]["annotations"]

    rid = pending(await k8s_exec("web-1", ["sh", "-c", "ls /data"], cluster="home", ctx=ctx()))
    assert "run `sh -c 'ls /data'` in pod default/web-1" in cards.raised[-1]["message"]
    r = (await http.post(f"/k8s/approvals/{rid}/approve", json=who("alice"))).json()
    assert json.loads(r["agent_message"].split("\n\n", 1)[1])["stdout"] == "ran sh -c ls /data\n"


async def test_reveal_returns_values_only_on_approve(configured, cards, http):
    rid = pending(await k8s_secret_reveal("db", ["password"], cluster="home", ctx=ctx()))
    assert "hunter2" not in cards.raised[0]["message"] and "transcript" in cards.raised[0]["message"]
    r = (await http.post(f"/k8s/approvals/{rid}/approve", json=who("alice"))).json()
    assert json.loads(r["agent_message"].split("\n\n", 1)[1]) == {"password": "hunter2"}
    missing = await k8s_secret_reveal("db", ["nope"], cluster="home", ctx=ctx())
    assert missing.is_error and "no key nope" in missing.text


async def test_cluster_approvers_replace_the_owner(configured, prod, http):
    prod.add({"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "api", "namespace": "default"},
              "spec": {"replicas": 1}})
    rid = pending(await k8s_scale("deploy", "api", 3, cluster="prod", ctx=ctx()))
    can = lambda body: http.post(f"/k8s/approvals/{rid}/can-approve", json=body)  # noqa: E731
    assert (await can(who("alice"))).json() == {"can_approve": False, "pending": True}
    assert (await can(who("u-7", "admin@example.com"))).json() == {"can_approve": True, "pending": True}
    refused = await http.post(f"/k8s/approvals/{rid}/approve", json=who("alice"))
    assert refused.status_code == 403 and prod.objects[("Deployment", "default", "api")]["spec"]["replicas"] == 1
    await http.post(f"/k8s/approvals/{rid}/approve", json=who("u-7", "admin@example.com"))
    assert prod.objects[("Deployment", "default", "api")]["spec"]["replicas"] == 3


async def test_only_the_owner_approves_by_default(configured, http):
    rid = pending(await k8s_delete("deploy", "web", cluster="home", ctx=ctx()))
    assert (await http.post(f"/k8s/approvals/{rid}/can-approve", json=who("bob"))).json() == {"can_approve": False, "pending": True}
    r = await k8s_delete("deploy", "web", cluster="home", ctx=ctx("ownerless"))
    assert r.is_error and "no known owner" in r.text


async def test_read_only_clusters_refuse_before_a_card(configured, cards):
    r = await k8s_apply(CM, cluster="ro", ctx=ctx())
    assert r.is_error and "read-only" in r.text and cards.raised == []


async def test_pending_requests_are_capped(configured):
    for _ in range(5):
        pending(await k8s_delete("deploy", "web", cluster="home", ctx=ctx()))
    r = await k8s_delete("deploy", "web", cluster="home", ctx=ctx())
    assert r.is_error and "waiting" in r.text


@pytest.fixture
async def granted(configured, http):
    rid = pending(await k8s_request_grant("default", 20, "rolling out the cache fix", cluster="home", ctx=ctx()))
    r = (await http.post(f"/k8s/approvals/{rid}/approve", json=who("alice"))).json()
    assert "until" in r["agent_message"], r
    return r["grant_id"]


async def test_a_grant_lets_namespaced_writes_run_at_once(granted, kube, cards):
    raised = len(cards.raised)
    r = await k8s_apply(CM, cluster="home", ctx=ctx())
    out = json.loads(r.text)
    assert out["status"] == "done" and out["grant_id"] == granted
    assert ("ConfigMap", "default", "settings") in kube.objects
    assert len(cards.raised) == raised
    assert [g["namespace"] for g in json.loads((await k8s_grants(ctx=ctx())).text)] == ["default"]


async def test_a_grant_never_covers_exec_reveal_or_cluster_scope(granted, cards):
    for r in (
        await k8s_exec("web-1", ["id"], cluster="home", ctx=ctx()),
        await k8s_secret_reveal("db", cluster="home", ctx=ctx()),
        await k8s_apply(NAMESPACE, cluster="home", ctx=ctx()),
        await k8s_apply(CM.replace("{name: settings}", "{name: settings, namespace: other}"), cluster="home", ctx=ctx()),
    ):
        pending(r)


async def test_a_grant_is_this_conversations_only(granted):
    pending(await k8s_apply(CM, cluster="home", ctx=ctx("other")))


async def test_grant_limits(configured):
    assert "between 1 and 30" in (await k8s_request_grant("default", 90, "x", cluster="home", ctx=ctx())).text
    assert "does not allow" in (await k8s_request_grant("default", 10, "x", cluster="prod", ctx=ctx())).text
    assert "reason" in (await k8s_request_grant("default", 10, " ", cluster="home", ctx=ctx())).text
