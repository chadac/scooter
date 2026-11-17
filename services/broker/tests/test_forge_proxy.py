"""The forge proxy end to end: a real TLS client through CONNECT, a mocked upstream."""

from __future__ import annotations

import base64
import gzip
import json
import ssl

import httpx
import pytest

from broker.forge import proxy as proxy_mod
from broker.forge.ca import LeafIssuer, ca_hosts, generate_ca
from broker.forge.proxy import ForgeProxy, ProxyAuthError, build_routes
from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.forge import Decision, ForgeHost, ForgeHosts
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.types import Identity, Provider


class _GitHubish:
    """Stand-in contrib dialect: `/repos/<o>/<r>` and `/graphql`."""

    def api_repo(self, path):
        p = path.strip("/").split("/")
        return f"{p[1]}/{p[2]}" if len(p) >= 3 and p[0] == "repos" else None

    def is_graphql(self, path):
        return path == "/graphql"


class _GitLabish:
    """Stand-in contrib dialect: `/api/v4/projects/<id>`."""

    def api_repo(self, path):
        from urllib.parse import unquote
        p = path.strip("/").split("/")
        return unquote(p[3]) if len(p) >= 4 and p[:3] == ["api", "v4", "projects"] else None

    def is_graphql(self, path):
        return path == "/api/graphql"

HOSTS = ["api.github.com", "github.com", "gitlab.com", "prod.k8s.scooter"]
IDENT = Identity(conversation_id="conv-1", namespace="ns", service_account="system:serviceaccount:ns:sandbox-conv-1")
A, B = "a" * 40, "b" * 40


def _pkt(line: bytes) -> bytes:
    return f"{len(line) + 4:04x}".encode() + line


class Recorder:
    """A policy that records what it saw and denies whatever `deny` says."""

    def __init__(self, deny=None):
        self.seen = []
        self.deny = deny

    async def check(self, request):
        self.seen.append(request)
        if self.deny and self.deny(request):
            return Decision.deny("not on my watch")
        return Decision.allow()


class _Unread(httpx.AsyncByteStream):
    """A response body the client has not read yet, like a real connection's; MockTransport pre-reads bytes/json content, which the proxy's aiter_raw rejects."""

    def __init__(self, data: bytes) -> None:
        self.data = data

    async def __aiter__(self):
        yield self.data


def _streamed(status: int, *, content: bytes = b"", json_body=None, headers=None) -> httpx.Response:
    """An httpx.Response whose body is still to be streamed."""
    hdrs = dict(headers or {})
    if json_body is not None:
        content = json.dumps(json_body).encode()
        hdrs["content-type"] = "application/json"
    hdrs["content-length"] = str(len(content))
    return httpx.Response(status, headers=hdrs, stream=_Unread(content))


@pytest.fixture(scope="module")
def ca():
    return generate_ca(HOSTS)


@pytest.fixture
def world(ca, monkeypatch):
    upstream_seen: list[tuple[httpx.Request, bytes]] = []
    links: list[Link] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        upstream_seen.append((request, body))
        if request.url.path == "/graphql":
            payload = {"data": {"createPullRequest": {"pullRequest": {"url": "https://github.com/o/r/pull/7", "title": "T"}}}}
            # Like GHES: compress whenever the request allows it.
            if "gzip" in request.headers.get("accept-encoding", ""):
                return _streamed(200, content=gzip.compress(json.dumps(payload).encode()),
                                 headers={"content-type": "application/json", "content-encoding": "gzip"})
            return _streamed(200, json_body=payload)
        if request.url.path.endswith("/merge_requests"):
            return _streamed(201, json_body={"web_url": "https://gitlab.com/g/p/-/merge_requests/3", "title": "MR"})
        return _streamed(200, content=b"upstream:" + body, headers={"x-up": "1"})

    async def fake_post_link(url, conversation_id, link):
        links.append(link)

    monkeypatch.setattr(proxy_mod, "post_link", fake_post_link)

    gh_policy, gl_policy = Recorder(), Recorder()
    github = Provider(
        name="github",
        credential=_RecordingSource(token="ghs_real"),
        transports=[ForgeHosts(
            hosts=[ForgeHost("github.com", git=True), ForgeHost("api.github.com", api_prefixes=("/",))],
            dialect=_GitHubish(),
            graphql_link_rules={"createPullRequest": lambda d, v: Link("github", "pr", d["pullRequest"]["url"], v["input"].get("title"))},
        )],
        forge_policy=gh_policy,
    )
    gitlab = Provider(
        name="gitlab",
        credential=StaticTokenSource(token="glpat-real", kind="header", header_name="PRIVATE-TOKEN"),
        transports=[ForgeHosts(
            hosts=[ForgeHost("gitlab.com", git=True, api_prefixes=("/api/",))],
            dialect=_GitLabish(), git_username="oauth2",
            link_rules=[rule("POST", r"^api/v4/projects/[^/]+/merge_requests/?$",
                             lambda r: Link("gitlab", "mr", r["web_url"]))],
        )],
        forge_policy=gl_policy,
    )

    kube_seen: list[httpx.Request] = []

    async def kube_handler(request: httpx.Request) -> httpx.Response:
        kube_seen.append(request)
        return _streamed(200, json_body={"kind": "PodList"})

    kube = Provider(
        name="k8s",
        credential=StaticTokenSource(token="kube-real"),
        transports=[ForgeHosts(
            hosts=[ForgeHost(
                "prod.k8s.scooter", api_prefixes=("/",), upstream="https://10.0.0.1:6443/",
                client=httpx.AsyncClient(transport=httpx.MockTransport(kube_handler)),
            )],
            upgrade_refusal="use k8s_exec",
            error_body=lambda code, message: {"kind": "Status", "code": code, "message": message},
            drop_header_prefixes=("Impersonate-",),
        )],
        forge_policy=Recorder(),
    )
    kube_policy = kube.forge_policy

    async def authenticate(token: str) -> Identity:
        if token != "good-sa-token":
            raise ProxyAuthError(407, "token not authenticated")
        return IDENT

    proxy = ForgeProxy(
        build_routes([github, gitlab, kube]), LeafIssuer(ca), authenticate,
        upstream=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        agent_host_url="http://agent-host",
    )
    proxy.kube_seen = kube_seen
    proxy.kube_policy = kube_policy
    return proxy, upstream_seen, links, gh_policy, gl_policy


class _RecordingSource(StaticTokenSource):
    """Records the forge request each credential is for."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self.requests = []

    async def get(self, identity, request=None):
        self.requests.append(request)
        return await super().get(identity, request)


def _client(proxy: ForgeProxy, ca, token: str = "good-sa-token") -> httpx.AsyncClient:
    verify = ssl.create_default_context(cadata=ca.cert_pem.decode())
    return httpx.AsyncClient(
        proxy=httpx.Proxy(f"http://127.0.0.1:{proxy.port}", headers={"Proxy-Authorization": f"Bearer {token}"}),
        verify=verify,
    )


@pytest.fixture
async def running(world):
    proxy = world[0]
    await proxy.start("127.0.0.1", 0)
    yield world
    await proxy.close()


async def test_git_fetch_gets_basic_auth_and_client_auth_is_dropped(running, ca):
    proxy, seen, _, policy, _ = running
    async with _client(proxy, ca) as c:
        r = await c.get(
            "https://github.com/o/r.git/info/refs?service=git-upload-pack",
            headers={"Authorization": "Bearer stolen-or-placeholder", "Cookie": "x=1"},
        )
    assert r.status_code == 200 and r.headers["x-up"] == "1"
    req, _ = seen[0]
    assert req.headers["authorization"] == "Basic " + base64.b64encode(b"x-access-token:ghs_real").decode()
    assert "cookie" not in req.headers
    assert str(req.url) == "https://github.com/o/r.git/info/refs?service=git-upload-pack"
    (fr,) = policy.seen
    assert (fr.kind, fr.repo, fr.git_service, fr.via) == ("git", "o/r", "git-upload-pack", "forge-proxy")
    assert fr.identity == IDENT


async def test_push_ref_updates_reach_the_policy_and_the_body_is_intact(running, ca):
    proxy, seen, _, policy, _ = running
    body = _pkt(f"{A} {B} refs/heads/feature\0report-status\n".encode()) + b"0000" + b"PACK" + bytes(range(256)) * 400
    async with _client(proxy, ca) as c:
        r = await c.post("https://github.com/o/r.git/git-receive-pack", content=body,
                         headers={"Content-Type": "application/x-git-receive-pack-request"})
    assert r.status_code == 200
    assert seen[0][1] == body
    assert r.content == b"upstream:" + body
    (fr,) = policy.seen
    assert fr.is_push and fr.is_mutation
    assert [(u.old, u.new, u.ref) for u in fr.ref_updates] == [(A, B, "refs/heads/feature")]


async def test_chunked_push_body(running, ca):
    proxy, seen, _, policy, _ = running

    async def chunks():
        yield _pkt(f"{A} {B} refs/heads/x\n".encode())
        yield b"0000PACK"
        yield b"rest"

    async with _client(proxy, ca) as c:
        r = await c.post("https://github.com/o/r.git/git-receive-pack", content=chunks())
    assert r.status_code == 200
    assert seen[0][1].endswith(b"0000PACKrest")
    assert policy.seen[0].ref_updates[0].ref == "refs/heads/x"


async def test_api_gets_bearer_and_keeps_the_connection(running, ca):
    proxy, seen, _, policy, _ = running
    async with _client(proxy, ca) as c:
        for _ in range(3):
            r = await c.get("https://api.github.com/repos/o/r", headers={"Authorization": "token scooter-forge-proxy"})
            assert r.status_code == 200
    assert [req.headers["authorization"] for req, _ in seen] == ["Bearer ghs_real"] * 3
    assert all(fr.kind == "api" and fr.repo == "o/r" for fr in policy.seen)


async def test_graphql_mutation_is_parsed_and_autolinked(running, ca):
    proxy, _, links, policy, _ = running
    query = "mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }"
    async with _client(proxy, ca) as c:
        r = await c.post("https://api.github.com/graphql", json={"query": query, "variables": {"input": {"title": "Add X"}}})
    assert r.json()["data"]["createPullRequest"]["pullRequest"]["url"].endswith("/pull/7")
    assert policy.seen[0].graphql[0].fields == ("createPullRequest",)
    assert links == [Link("github", "pr", "https://github.com/o/r/pull/7", "Add X")]


async def test_an_autolinked_call_asks_upstream_for_an_uncompressed_body(running, ca):
    """httpx would send its default gzip if the header were only dropped; the body is parsed raw."""
    proxy, seen, links, _, _ = running
    query = "mutation PullRequestCreate($input: CreatePullRequestInput!) { createPullRequest(input: $input) { pullRequest { url } } }"
    async with _client(proxy, ca) as c:
        await c.post("https://api.github.com/graphql", headers={"accept-encoding": "gzip"},
                     json={"query": query, "variables": {"input": {"title": "Zipped"}}})
    assert seen[-1][0].headers["accept-encoding"] == "identity"
    assert links[-1] == Link("github", "pr", "https://github.com/o/r/pull/7", "Zipped")


async def test_the_credential_source_sees_the_request(running, ca):
    """A multi-installation source picks by owner, so it needs the request."""
    proxy = running[0]
    async with _client(proxy, ca) as c:
        await c.get("https://api.github.com/repos/o/r", headers={"Authorization": "token scooter-forge-proxy"})
        await c.post("https://api.github.com/graphql", json={"query": "query { viewer { login } }", "variables": {"owner": "o"}})
    seen = proxy.routes["api.github.com"].provider.credential.requests
    assert seen[0].repo == "o/r"
    assert json.loads(seen[1].graphql_body)["variables"] == {"owner": "o"}


async def test_gitlab_api_gets_private_token_and_keeps_encoded_path(running, ca):
    proxy, seen, links, _, policy = running
    async with _client(proxy, ca) as c:
        r = await c.post("https://gitlab.com/api/v4/projects/g%2Fp/merge_requests",
                         json={"title": "MR"}, headers={"PRIVATE-TOKEN": "scooter-forge-proxy"})
    assert r.status_code == 201
    req, _ = seen[0]
    assert req.headers["private-token"] == "glpat-real"
    assert "authorization" not in req.headers
    assert req.url.raw_path == b"/api/v4/projects/g%2Fp/merge_requests"
    assert policy.seen[0].repo == "g/p"
    assert links == [Link("gitlab", "mr", "https://gitlab.com/g/p/-/merge_requests/3")]


async def test_gitlab_git_uses_oauth2_basic(running, ca):
    proxy, seen, _, _, _ = running
    async with _client(proxy, ca) as c:
        await c.get("https://gitlab.com/g/sub/p.git/info/refs?service=git-upload-pack")
    assert seen[0][0].headers["authorization"] == "Basic " + base64.b64encode(b"oauth2:glpat-real").decode()


async def test_web_paths_get_no_credential(running, ca):
    proxy, seen, _, policy, _ = running
    async with _client(proxy, ca) as c:
        await c.get("https://github.com/o/r/pulls", headers={"Authorization": "Bearer x"})
    assert "authorization" not in seen[0][0].headers
    assert policy.seen[0].kind == "web"


async def test_dot_segments_escaping_a_scoped_prefix_get_no_credential(running, ca):
    proxy, seen, _, _, policy = running
    async with _client(proxy, ca) as c:
        await c.get("https://gitlab.com/api/%2e%2e/%2e%2e/g/p/-/raw/main/x",
                    headers={"PRIVATE-TOKEN": "scooter-forge-proxy"})
    req, _ = seen[0]
    assert "private-token" not in req.headers
    assert req.url.raw_path == b"/api/%2e%2e/%2e%2e/g/p/-/raw/main/x"
    assert policy.seen[0].kind == "web"


async def test_denied_request_never_reaches_upstream(running, ca):
    proxy, seen, _, policy, _ = running
    policy.deny = lambda fr: fr.is_push
    body = _pkt(f"{A} {B} refs/heads/main\n".encode()) + b"0000PACK"
    async with _client(proxy, ca) as c:
        r = await c.post("https://github.com/o/r.git/git-receive-pack", content=body)
    assert r.status_code == 403
    assert r.headers["x-scooter-policy"] == "not on my watch"
    assert "forge policy" in r.json()["message"]
    assert seen == []


async def test_a_host_with_its_own_upstream_uses_its_url_and_client(running, ca):
    proxy, seen, *_ = running
    async with _client(proxy, ca) as c:
        r = await c.get("https://prod.k8s.scooter/api/v1/namespaces/default/pods?limit=5")
    assert r.status_code == 200 and r.json() == {"kind": "PodList"}
    (req,) = proxy.kube_seen
    assert str(req.url) == "https://10.0.0.1:6443/api/v1/namespaces/default/pods?limit=5"
    assert req.headers["host"] == "10.0.0.1:6443"
    assert req.headers["authorization"] == "Bearer kube-real"
    assert seen == []


async def test_client_impersonation_headers_are_dropped(running, ca):
    proxy = running[0]
    async with _client(proxy, ca) as c:
        r = await c.get(
            "https://prod.k8s.scooter/api/v1/secrets",
            headers={"Impersonate-User": "admin", "Impersonate-Group": "system:masters",
                     "Impersonate-Extra-scopes": "x"},
        )
    assert r.status_code == 200
    (req,) = proxy.kube_seen
    assert not [k for k in req.headers if k.lower().startswith("impersonate-")]


async def test_header_drops_apply_only_to_the_provider_that_set_them(running, ca):
    proxy, seen, *_ = running
    async with _client(proxy, ca) as c:
        r = await c.get("https://api.github.com/repos/o/r", headers={"Impersonate-User": "x"})
    assert r.status_code == 200
    ((req, _),) = seen
    assert req.headers["impersonate-user"] == "x"


async def test_upgrade_requests_are_refused_with_the_hosts_message(running, ca):
    proxy = running[0]
    async with _client(proxy, ca) as c:
        r = await c.post(
            "https://prod.k8s.scooter/api/v1/namespaces/default/pods/p/exec?command=sh",
            headers={"Connection": "Upgrade", "Upgrade": "websocket"},
        )
    assert r.status_code == 403
    assert r.json() == {"kind": "Status", "code": 403, "message": "use k8s_exec"}
    assert proxy.kube_seen == []


async def test_a_denial_uses_the_hosts_error_body(running, ca):
    proxy = running[0]
    proxy.kube_policy.deny = lambda fr: fr.method == "POST"
    async with _client(proxy, ca) as c:
        r = await c.post("https://prod.k8s.scooter/api/v1/namespaces/default/configmaps", json={})
    assert r.status_code == 403
    assert r.json()["kind"] == "Status" and "forge policy" in r.json()["message"]
    assert proxy.kube_seen == []


async def test_non_forge_host_is_refused(running, ca):
    proxy = running[0]
    async with _client(proxy, ca) as c:
        with pytest.raises(httpx.ProxyError):
            await c.get("https://example.com/")


async def test_bad_token_is_407(running, ca):
    proxy = running[0]
    async with _client(proxy, ca, token="nope") as c:
        with pytest.raises(httpx.ProxyError):
            await c.get("https://github.com/o/r.git/info/refs")


def test_ca_is_name_constrained_to_the_forge_hosts(ca):
    assert ca_hosts(ca.cert_pem) == HOSTS


def test_two_providers_cannot_claim_one_host():
    a = Provider(name="a", transports=[ForgeHosts(hosts=[ForgeHost("h.example")])])
    b = Provider(name="b", transports=[ForgeHosts(hosts=[ForgeHost("h.example")])])
    with pytest.raises(ValueError):
        build_routes([a, b])


def _handshake(server_ctx: ssl.SSLContext, cadata: str, host: str) -> None:
    """Raise unless a client trusting `cadata` accepts `server_ctx` for `host`."""
    import socket
    import threading

    client_ctx = ssl.create_default_context(cadata=cadata)
    a, b = socket.socketpair()

    def serve():
        try:
            with server_ctx.wrap_socket(b, server_side=True):
                pass
        except (ssl.SSLError, OSError):
            pass

    t = threading.Thread(target=serve)
    t.start()
    try:
        with client_ctx.wrap_socket(a, server_hostname=host):
            pass
    finally:
        a.close()
        t.join()


def test_each_host_is_signed_by_the_ca_that_covers_it():
    old, new = generate_ca(["github.com"]), generate_ca(["gitlab.com"])
    issuer = LeafIssuer(old, new)
    # A sandbox that booted before gitlab.com was added still verifies github.com.
    _handshake(issuer.context_for("github.com"), old.cert_pem.decode(), "github.com")
    _handshake(issuer.context_for("api.github.com"), old.cert_pem.decode(), "api.github.com")
    _handshake(issuer.context_for("gitlab.com"), new.cert_pem.decode(), "gitlab.com")


def test_leaf_for_an_unconstrained_host_does_not_verify(ca):
    """Even a leaf the CA signs for another host is rejected by the client, because of the name constraints."""
    import socket
    import threading

    server_ctx = LeafIssuer(ca).context_for("example.com")
    client_ctx = ssl.create_default_context(cadata=ca.cert_pem.decode())
    a, b = socket.socketpair()
    result: dict[str, object] = {}

    def serve():
        try:
            with server_ctx.wrap_socket(b, server_side=True):
                pass
        except (ssl.SSLError, OSError):
            pass

    t = threading.Thread(target=serve)
    t.start()
    try:
        with client_ctx.wrap_socket(a, server_hostname="example.com"):
            result["ok"] = True
    except ssl.SSLCertVerificationError as e:
        result["err"] = e
    t.join()
    assert "err" in result, "a leaf outside the name constraints verified"

