"""The tools' path: KubeGateway enforces KubePolicy and adds the credential, as the proxy does."""

from __future__ import annotations

import json

import httpx
import pytest

from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_contrib_k8s.auth import Endpoint
from scooter_contrib_k8s.config import ClusterConfig
from scooter_contrib_k8s.forge import ClusterLink, KubePolicy
from scooter_contrib_k8s.kube import Actor, K8sError, Kube, KubeGateway, Resource, _exit_code
from scooter_contrib_k8s.store import GrantStore, _Base

CM = Resource("v1", "ConfigMap", "configmaps", True)
NS = Resource("v1", "Namespace", "namespaces", False)
SECRET = Resource("v1", "Secret", "secrets", True)


class FakeAuth:
    ttl = None

    async def endpoint(self):
        return Endpoint(server="https://10.0.0.1:6443/base", token="real-token")


class Api:
    """A fake API server: records each request and answers from `routes`."""

    def __init__(self) -> None:
        self.seen: list[httpx.Request] = []
        self.routes: dict[str, httpx.Response] = {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(request)
        for prefix, resp in self.routes.items():
            if request.url.path == prefix:
                return resp
        return httpx.Response(200, json={"kind": "Thing", "metadata": {"name": "x"}, "items": []})


@pytest.fixture
async def grants():
    g = GrantStore(sqlite_config())
    await create_schema(g, _Base)
    return g


@pytest.fixture
def api():
    return Api()


@pytest.fixture
def kube(api, grants):
    cfg = {"home": ClusterConfig(name="home", auth={"type": "inCluster"}, grants_enabled=True,
                                 impersonate="scooter-k8s")}
    links = {"home": ClusterLink(FakeAuth(), inner=httpx.MockTransport(api))}
    return Kube(KubeGateway(cfg, links, KubePolicy(cfg, grants)), "home")


async def test_reads_go_as_the_broker(kube, api):
    await kube.list(CM, "web", label_selector="app=x", limit=5)
    (sent,) = api.seen
    assert str(sent.url) == "https://10.0.0.1:6443/base/api/v1/namespaces/web/configmaps?labelSelector=app%3Dx&limit=5"
    assert sent.headers["authorization"] == "Bearer real-token"
    assert not any(k.startswith("impersonate-") for k in sent.headers)


async def test_a_secret_read_needs_a_grant_unless_redacted(kube, api, grants):
    with pytest.raises(K8sError, match="403 denied by the Scooter forge policy: reading Secret web/db needs a grant"):
        await kube.get(SECRET, "db", "web", actor=Actor("conv"))
    with pytest.raises(K8sError, match="403 .*can't be listed"):
        await kube.list(SECRET, "web", actor=Actor("conv"))
    assert api.seen == []
    await kube.list(SECRET, "web", redacted=True)
    await kube.get(SECRET, "db", "web", redacted=True)
    assert not any(k.startswith("impersonate-") for r in api.seen for k in r.headers)
    await grants.add("conv", "home", "web", minutes=5, approved_by="alice", request_id="r1", kind="secret",
                     names=("db",))
    await kube.get(SECRET, "db", "web", actor=Actor("conv"))
    assert api.seen[-1].headers["impersonate-extra-scooter-approver"] == "alice"


async def test_writes_need_a_grant_but_dry_runs_pass(kube, api, grants):
    body = {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "s", "namespace": "web"}}
    with pytest.raises(K8sError, match="403 .*k8s_request_grant"):
        await kube.apply(CM, body, dry_run=False, actor=Actor("conv"))
    await kube.apply(CM, body, dry_run=True, actor=Actor("conv"))
    (sent,) = api.seen
    assert sent.method == "PATCH" and sent.url.path == "/base/api/v1/namespaces/web/configmaps/s"
    assert sent.url.params["dryRun"] == "All" and sent.url.params["fieldManager"] == "scooter"
    assert sent.headers["content-type"] == "application/apply-patch+yaml"
    assert json.loads(sent.content) == body
    assert sent.headers["impersonate-user"] == "scooter-k8s"
    assert sent.headers["impersonate-extra-scooter-conversation"] == "conv"
    assert "impersonate-extra-scooter-approver" not in sent.headers

    await grants.add("conv", "home", "web", minutes=5, approved_by="alice", request_id="r1")
    await kube.delete(CM, "s", "web", dry_run=False, actor=Actor("conv"))
    sent = api.seen[-1]
    assert sent.method == "DELETE" and json.loads(sent.content)["propagationPolicy"] == "Background"
    assert sent.headers["impersonate-extra-scooter-approver"] == "alice"


async def test_an_approved_card_covers_what_no_grant_can(kube, api):
    with pytest.raises(K8sError, match="cluster-scoped"):
        await kube.delete(NS, "web", None, dry_run=False, actor=Actor("conv"))
    await kube.delete(NS, "web", None, dry_run=False, actor=Actor("conv", "bob"))
    assert api.seen[-1].url.path == "/base/api/v1/namespaces/web"
    assert api.seen[-1].headers["impersonate-extra-scooter-approver"] == "bob"


async def test_exec_needs_an_approved_card(kube):
    gw = kube._gw
    path = "/api/v1/namespaces/web/pods/p/exec"
    with pytest.raises(K8sError, match="403 .*k8s_exec"):
        await gw.stream("home", path, [("command", "id")], actor=Actor("conv"))
    url, headers, _ = await gw.stream("home", path, [("command", "id")], actor=Actor("conv", "bob"))
    assert url == "wss://10.0.0.1:6443/base/api/v1/namespaces/web/pods/p/exec?command=id"
    assert headers["Authorization"] == "Bearer real-token"
    assert headers["Impersonate-Extra-scooter-approver"] == "bob"


async def test_api_errors_carry_the_status_message(kube, api):
    api.routes["/base/api/v1/namespaces/web/configmaps/gone"] = httpx.Response(
        404, json={"kind": "Status", "message": 'configmaps "gone" not found'})
    with pytest.raises(K8sError, match='404 configmaps "gone" not found') as e:
        await kube.get(CM, "gone", "web")
    assert e.value.status == 404


async def test_aggregated_discovery(kube, api):
    api.routes["/base/api"] = httpx.Response(200, json={"kind": "APIGroupDiscoveryList", "items": [
        {"metadata": {"name": ""}, "versions": [{"version": "v1", "resources": [
            {"resource": "pods", "responseKind": {"kind": "Pod"}, "scope": "Namespaced", "shortNames": ["po"]}]}]}]})
    api.routes["/base/apis"] = httpx.Response(200, json={"kind": "APIGroupDiscoveryList", "items": [
        {"metadata": {"name": "apps"}, "versions": [
            {"version": "v1", "resources": [{"resource": "deployments", "responseKind": {"kind": "Deployment"},
                                             "scope": "Namespaced", "shortNames": ["deploy"]}]},
            {"version": "v1beta1", "resources": [{"resource": "deployments", "responseKind": {"kind": "Deployment"},
                                                  "scope": "Namespaced"}]}]}]})
    assert (await kube.resource("deploy")).api_version == "apps/v1"
    assert (await kube.resource("po")).name == "pods"
    assert not (await kube.resource("Deployment", "apps/v1beta1")).preferred
    assert [r.url.path for r in api.seen] == ["/base/api", "/base/apis"]
    assert "apidiscovery.k8s.io" in api.seen[0].headers["accept"]
    await kube.resource("pods")
    assert len(api.seen) == 2


async def test_legacy_discovery_skips_a_broken_group(kube, api):
    api.routes["/base/api"] = httpx.Response(200, json={"kind": "APIVersions", "versions": ["v1"]})
    api.routes["/base/apis"] = httpx.Response(200, json={"kind": "APIGroupList", "groups": [
        {"name": "apps", "versions": [{"groupVersion": "apps/v1"}], "preferredVersion": {"groupVersion": "apps/v1"}},
        {"name": "metrics.k8s.io", "versions": [{"groupVersion": "metrics.k8s.io/v1beta1"}]}]})
    api.routes["/base/api/v1"] = httpx.Response(200, json={"groupVersion": "v1", "resources": [
        {"name": "pods", "kind": "Pod", "namespaced": True}, {"name": "pods/log", "kind": "Pod", "namespaced": True}]})
    api.routes["/base/apis/apps/v1"] = httpx.Response(200, json={"groupVersion": "apps/v1", "resources": [
        {"name": "deployments", "kind": "Deployment", "namespaced": True, "shortNames": ["deploy"]}]})
    api.routes["/base/apis/metrics.k8s.io/v1beta1"] = httpx.Response(503, text="unavailable")
    found = await kube.api_resources()
    assert [(r.api_version, r.name) for r in found] == [("apps/v1", "deployments"), ("v1", "pods")]


def test_exit_code_from_the_status_channel():
    failed = {"status": "Failure", "reason": "NonZeroExitCode",
              "details": {"causes": [{"reason": "ExitCode", "message": "3"}]}}
    assert _exit_code(json.dumps({"status": "Success"}).encode()) == 0
    assert _exit_code(json.dumps(failed).encode()) == 3
    assert _exit_code(None) is None and _exit_code(b"not json") is None
