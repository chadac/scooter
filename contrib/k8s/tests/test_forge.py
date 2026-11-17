"""kubectl and helm through the forge proxy: path parsing, KubePolicy, the credential and the transport."""

from __future__ import annotations

import json

import httpx
import pytest
from kubernetes import client

from scooter_broker_lib.forge import ForgeRequest
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity
from scooter_contrib_k8s.broker_provider import forge_hosts
from scooter_contrib_k8s.config import ClusterConfig
from scooter_contrib_k8s.forge import ClusterLink, KubeCredential, KubePolicy, KubeTransport, parse
from scooter_contrib_k8s.store import GrantStore, _Base

CLUSTERS = {
    "home": ClusterConfig(name="home", auth={"type": "inCluster"}, grants_enabled=True, impersonate="scooter-k8s"),
    "ro": ClusterConfig(name="ro", auth={"type": "inCluster"}, read_only=True),
    "plain": ClusterConfig(name="plain", auth={"type": "inCluster"}),
}


@pytest.mark.parametrize("method,path,query,want", [
    ("GET", "/api/v1/namespaces/web/pods", "", dict(group="", resource="pods", namespace="web")),
    ("GET", "/api/v1/namespaces/web/pods/p1/log", "follow=true",
     dict(resource="pods", namespace="web", name="p1", subresource="log")),
    ("GET", "/api/v1/watch/namespaces/web/secrets", "", dict(resource="secrets", namespace="web", watch=True)),
    ("GET", "/api/v1/secrets", "watch=1", dict(resource="secrets", namespace="", watch=True)),
    ("PATCH", "/apis/apps/v1/namespaces/web/deployments/api", "dryRun=All&fieldManager=kubectl",
     dict(group="apps", resource="deployments", namespace="web", name="api", dry_run=True)),
    ("DELETE", "/api/v1/namespaces/web", "", dict(resource="namespaces", namespace="", name="web")),
    ("PUT", "/api/v1/namespaces/web/finalize", "", dict(resource="namespaces", name="web", subresource="finalize")),
    ("GET", "/version", "", dict(group=None)),
    ("GET", "/apis", "", dict(group=None)),
])
def test_parse(method, path, query, want):
    r = parse(method, path, query)
    for k, v in want.items():
        assert getattr(r, k) == v, (k, r)


@pytest.fixture
async def grants():
    g = GrantStore(sqlite_config())
    await create_schema(g, _Base)
    return g


@pytest.fixture
def policy(grants):
    return KubePolicy(CLUSTERS, grants)


def req(method: str, path: str, query: str = "", *, host: str = "home.k8s.scooter", cid: str = "conv"):
    ident = Identity(conversation_id=cid, namespace="ns", service_account="sandbox")
    return ForgeRequest(identity=ident, provider="k8s", via="forge-proxy", method=method, host=host,
                        path=path, query=query, kind="api")


async def decide(policy, *a, **kw):
    return await policy.check(req(*a, **kw))


async def test_reads_pass_and_streams_are_refused(policy):
    assert (await decide(policy, "GET", "/api/v1/namespaces/web/pods")).allowed
    assert (await decide(policy, "GET", "/apis/apps/v1/deployments", "watch=true")).allowed
    assert (await decide(policy, "GET", "/openapi/v3")).allowed
    for sub in ("exec", "attach", "portforward"):
        d = await decide(policy, "POST", f"/api/v1/namespaces/web/pods/p/{sub}")
        assert not d.allowed and "k8s_exec" in d.reason
    assert not (await decide(policy, "GET", "/api/v1/nodes/n1/proxy/metrics")).allowed
    assert not (await decide(policy, "GET", "/api/v1/pods", host="nope.k8s.scooter")).allowed


async def test_writes_need_a_write_grant(policy, grants):
    patch = ("PATCH", "/apis/apps/v1/namespaces/web/deployments/api")
    d = await decide(policy, *patch)
    assert not d.allowed and "k8s_request_grant" in d.reason
    assert (await decide(policy, *patch, "dryRun=All")).allowed
    await grants.add("conv", "home", "web", minutes=5, approved_by="alice", request_id="r1")
    assert (await decide(policy, *patch)).allowed
    assert not (await decide(policy, *patch, cid="other")).allowed
    assert not (await decide(policy, "PATCH", "/apis/apps/v1/namespaces/db/deployments/api")).allowed
    d = await decide(policy, "DELETE", "/api/v1/namespaces/web")
    assert not d.allowed and "k8s_delete" in d.reason
    d = await decide(policy, *patch, host="plain.k8s.scooter")
    assert not d.allowed and "k8s_apply" in d.reason


async def test_read_only_clusters_take_reads_only(policy):
    assert (await decide(policy, "GET", "/api/v1/pods", host="ro.k8s.scooter")).allowed
    for m, p, q in (("PATCH", "/api/v1/namespaces/web/pods/p", "dryRun=All"),
                    ("GET", "/api/v1/namespaces/web/secrets/db", "")):
        d = await decide(policy, m, p, q, host="ro.k8s.scooter")
        assert not d.allowed and "read-only" in d.reason


async def test_secrets_need_a_secret_grant(policy, grants):
    get = ("GET", "/api/v1/namespaces/web/secrets/db")
    d = await decide(policy, *get)
    assert not d.allowed and "k8s_request_secret_access" in d.reason
    await grants.add("conv", "home", "web", minutes=5, approved_by="alice", request_id="r1",
                     kind="secret", names=("db", "api-key"))
    assert (await decide(policy, *get)).allowed
    assert not (await decide(policy, "GET", "/api/v1/namespaces/web/secrets/other")).allowed
    assert not (await decide(policy, "GET", "/api/v1/namespaces/db/secrets/db")).allowed
    # A Secret grant opens reads, never lists or writes.
    assert not (await decide(policy, "GET", "/api/v1/namespaces/web/secrets")).allowed
    assert not (await decide(policy, "GET", "/api/v1/secrets")).allowed
    assert not (await decide(policy, "PUT", "/api/v1/namespaces/web/secrets/db")).allowed


async def test_helm_release_reads_pass_without_a_grant(policy):
    lst = ("GET", "/api/v1/namespaces/web/secrets", "labelSelector=owner%3Dhelm%2Cname%3Dapi")
    for req in [lst, ("GET", "/api/v1/secrets", "labelSelector=owner%3Dhelm"),
                ("GET", "/api/v1/namespaces/web/secrets/sh.helm.release.v1.api.v3")]:
        d = await decide(policy, *req)
        assert d.allowed and not parse(*req).privileged, req
    assert (await decide(policy, *lst, host="ro.k8s.scooter")).allowed
    assert not (await decide(policy, "GET", "/api/v1/namespaces/web/secrets", "labelSelector=app%3Dx")).allowed
    assert not (await decide(policy, "GET", "/api/v1/namespaces/web/secrets", "labelSelector=owner%3Dhelm&watch=1")).allowed
    assert not (await decide(policy, "DELETE", "/api/v1/namespaces/web/secrets/sh.helm.release.v1.api.v3")).allowed


class FakeAuth:
    ttl = None

    def __init__(self, host="https://10.0.0.1:6443"):
        self.host = host
        self.built = 0

    async def configuration(self):
        self.built += 1
        c = client.Configuration()
        c.host = self.host
        c.api_key = {"authorization": "real-token"}
        c.api_key_prefix = {"authorization": "Bearer"}
        return c


async def test_transport_sends_to_the_real_api_server():
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"kind": "PodList"})

    link = ClusterLink(FakeAuth(), inner=httpx.MockTransport(handler))
    async with httpx.AsyncClient(transport=KubeTransport(link)) as c:
        r = await c.get("https://home.k8s.scooter/api/v1/pods?limit=5")
    assert r.status_code == 200
    (sent,) = seen
    assert str(sent.url) == "https://10.0.0.1:6443/api/v1/pods?limit=5"
    assert sent.headers["host"] == "10.0.0.1:6443"


def _helm_link(seen, secret_type="helm.sh/release.v1"):
    def handler(request):
        seen.append(request)
        if request.url.path.endswith("/secrets"):
            return httpx.Response(200, json={"kind": "SecretList", "items": []})
        return httpx.Response(200, json={"kind": "Secret", "type": secret_type, "data": {"release": "eA=="}})
    return ClusterLink(FakeAuth(), inner=httpx.MockTransport(handler))


async def test_transport_narrows_helm_lists_to_release_secrets():
    seen = []
    async with httpx.AsyncClient(transport=KubeTransport(_helm_link(seen))) as c:
        await c.get("https://home.k8s.scooter/api/v1/secrets",
                    params={"labelSelector": "owner=helm", "fieldSelector": "metadata.namespace!=x"})
        await c.get("https://home.k8s.scooter/api/v1/pods", params={"labelSelector": "owner=helm"})
    helm, pods = seen
    assert helm.url.params.get_list("fieldSelector") == ["metadata.namespace!=x,type=helm.sh/release.v1"]
    assert "fieldSelector" not in pods.url.params


async def test_transport_refuses_a_named_secret_that_is_not_a_release():
    url = "https://home.k8s.scooter/api/v1/namespaces/web/secrets/sh.helm.release.v1.api.v1"
    seen = []
    async with httpx.AsyncClient(transport=KubeTransport(_helm_link(seen))) as c:
        ok = await c.get(url, headers={"Accept": "application/vnd.kubernetes.protobuf"})
    assert ok.status_code == 200 and ok.json()["type"] == "helm.sh/release.v1"
    assert seen[0].headers["accept"] == "application/json"
    async with httpx.AsyncClient(transport=KubeTransport(_helm_link([], "Opaque"))) as c:
        bad = await c.get(url)
    assert bad.status_code == 403 and bad.json()["kind"] == "Status"
    assert "eA==" not in bad.text


async def test_credential_impersonates_only_privileged_calls(policy, grants):
    links = {n: ClusterLink(FakeAuth()) for n in CLUSTERS}
    cred = KubeCredential(CLUSTERS, links, policy)
    await grants.add("conv", "home", "web", minutes=5, approved_by="alice", request_id="r1")

    async def headers(*a, **kw):
        r = req(*a, **kw)
        return json.loads((await cred.get(r.identity, r)).value)

    assert await headers("GET", "/api/v1/namespaces/web/pods") == {"Authorization": "Bearer real-token"}
    assert await headers("PATCH", "/api/v1/namespaces/web/pods/p") == {
        "Authorization": "Bearer real-token",
        "Impersonate-User": "scooter-k8s",
        "Impersonate-Extra-scooter-conversation": "conv",
        "Impersonate-Extra-scooter-approver": "alice",
    }
    assert "Impersonate-User" not in await headers("PATCH", "/api/v1/namespaces/web/pods/p",
                                                   host="plain.k8s.scooter")


def test_forge_hosts_strip_client_impersonation():
    fh = forge_hosts({"home": ClusterLink(FakeAuth())})
    assert [h.host for h in fh.hosts] == ["home.k8s.scooter"]
    assert fh.drop_header_prefixes == ("impersonate-",)
    assert "k8s_exec" in fh.upgrade_refusal
    assert fh.error_body(403, "no") == {
        "kind": "Status", "apiVersion": "v1", "metadata": {}, "status": "Failure",
        "message": "no", "reason": "Forbidden", "code": 403,
    }
