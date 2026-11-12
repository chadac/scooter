"""Forge request parsing, the policy hook, and its enforcement on the http-proxy."""

from __future__ import annotations

import gzip
import sys
import types

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_broker_lib.forge import (
    ALLOW_ALL,
    DENY_HEADER,
    Decision,
    ForgeHost,
    ForgeHosts,
    ForgeRequest,
    GenericDialect,
    PushHeadReader,
    api_forge_request,
    classify,
    enforce,
    load_policy,
    parse_graphql,
    parse_graphql_body,
)
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity, Provider

IDENT = Identity(conversation_id="c1", namespace="ns", service_account="system:serviceaccount:ns:sandbox-c1")


class _Dialect:
    """A stand-in for a contrib's dialect: `/repos/<o>/<r>` and `/graphql`."""

    def api_repo(self, path: str) -> str | None:
        parts = path.strip("/").split("/")
        return f"{parts[1]}/{parts[2]}" if len(parts) >= 3 and parts[0] == "repos" else None

    def is_graphql(self, path: str) -> bool:
        return path == "/graphql"


GH_GIT = dict(dialect=_Dialect(), git=True, api_prefixes=())
GH_API = dict(dialect=_Dialect(), git=False, api_prefixes=("/",))
GL = dict(dialect=GenericDialect(), git=True, api_prefixes=("/api/",))


# -- classify ---------------------------------------------------------------

@pytest.mark.parametrize("path,query,repo,service", [
    ("/o/r.git/info/refs", "service=git-upload-pack", "o/r", "git-upload-pack"),
    ("/o/r/info/refs", "service=git-receive-pack", "o/r", "git-receive-pack"),
    ("/o/r.git/git-receive-pack", "", "o/r", "git-receive-pack"),
    ("/o/r.git/git-upload-pack", "", "o/r", "git-upload-pack"),
    ("/o/r.git/info/lfs/objects/batch", "", "o/r", "git-lfs"),
])
def test_github_git_paths(path, query, repo, service):
    c = classify(path=path, query=query, **GH_GIT)
    assert (c.kind, c.repo, c.git_service) == ("git", repo, service)


def test_github_web_path_is_not_git():
    assert classify(path="/o/r/pulls", **GH_GIT).kind == "web"


def test_github_api_repo():
    c = classify(path="/repos/o/r/pulls", **GH_API)
    assert (c.kind, c.repo) == ("api", "o/r")
    assert classify(path="/graphql", **GH_API).repo is None


def test_nested_git_and_generic_api():
    c = classify(path="/g/sub/p.git/git-receive-pack", **GL)
    assert (c.kind, c.repo, c.git_service) == ("git", "g/sub/p", "git-receive-pack")
    c = classify(path="/api/v4/projects/42", **GL)
    assert (c.kind, c.repo) == ("api", None)
    assert classify(path="/g/p/-/merge_requests", **GL).kind == "web"


# -- receive-pack ref updates ----------------------------------------------

def _pkt(line: bytes) -> bytes:
    return f"{len(line) + 4:04x}".encode() + line


A, B, Z = "a" * 40, "b" * 40, "0" * 40
PUSH = (
    _pkt(f"{A} {B} refs/heads/main\0 report-status side-band-64k\n".encode())
    + _pkt(f"{Z} {B} refs/heads/new\n".encode())
    + _pkt(f"{A} {Z} refs/heads/gone\n".encode())
    + b"0000PACK\x00\x00\x00\x02"
)


def test_push_head_in_one_chunk():
    r = PushHeadReader()
    updates = r.feed(PUSH)
    assert [u.ref for u in updates] == ["refs/heads/main", "refs/heads/new", "refs/heads/gone"]
    assert updates[1].is_create and updates[2].is_delete and not updates[0].is_delete


def test_push_head_split_across_chunks():
    r = PushHeadReader()
    for i in range(0, len(PUSH) - 1, 7):
        result = r.feed(PUSH[i:i + 7])
    assert result is not None and len(result) == 3


def test_push_head_gzipped():
    r = PushHeadReader(gzipped=True)
    data = gzip.compress(PUSH)
    assert r.feed(data[:10]) is None
    assert len(r.feed(data[10:])) == 3


def test_push_head_garbage_fails():
    r = PushHeadReader()
    assert r.feed(b"zzzz not pkt") is None and r.failed


def test_push_cert_is_not_parsed():
    r = PushHeadReader()
    r.feed(_pkt(b"push-cert\0caps\n") + b"0000")
    assert r.failed and r.updates is None


# -- GraphQL ---------------------------------------------------------------

def test_graphql_named_mutation():
    (op,) = parse_graphql(
        'mutation PullRequestCreate($input: CreatePullRequestInput!) '
        '{ createPullRequest(input: $input) { pullRequest { id url } } }'
    )
    assert (op.type, op.name, op.fields) == ("mutation", "PullRequestCreate", ("createPullRequest",))


def test_graphql_anonymous_query_aliases_and_strings():
    (op,) = parse_graphql('{ r: repository(owner: "o", name: "has { brace") { id } viewer { login } }')
    assert (op.type, op.fields) == ("query", ("repository", "viewer"))


def test_graphql_fragments_and_inline_fragments_count_as_top_level():
    doc = """
      # a comment { mutation }
      mutation { ... on Mutation { deleteRef(input: {}) { clientMutationId } } ...F }
      fragment F on Mutation { mergePullRequest(input: {}) { clientMutationId } }
    """
    (op,) = parse_graphql(doc)
    assert op.fields == ("deleteRef", "mergePullRequest")


def test_graphql_body_batch_and_garbage():
    ops = parse_graphql_body(b'[{"query": "query { viewer { login } }"}, {"query": "mutation { addStar { x } }"}]')
    assert [o.type for o in ops] == ["query", "mutation"]
    assert parse_graphql_body(b"not json") is None
    assert parse_graphql_body(b'{"query": "mutation {"}') is None


# -- the policy hook -------------------------------------------------------

def _req(**kw) -> ForgeRequest:
    base = dict(identity=IDENT, provider="github", via="forge-proxy", method="GET",
                host="github.com", path="/o/r.git/info/refs", kind="git")
    base.update(kw)
    return ForgeRequest(**base)


def test_is_mutation():
    assert not _req(git_service="git-receive-pack").is_mutation  # discovery GET
    assert _req(method="POST", git_service="git-receive-pack").is_mutation
    assert _req(kind="api", method="DELETE").is_mutation
    assert not _req(kind="api", method="POST", graphql=parse_graphql("{ viewer { login } }")).is_mutation


async def test_enforce_fails_closed_when_the_policy_raises():
    class Broken:
        async def check(self, request):
            raise RuntimeError("boom")

    d = await enforce(Broken(), _req())
    assert not d.allowed and "RuntimeError" in d.reason
    assert (await enforce(None, _req())).allowed


def test_load_policy_from_spec(monkeypatch):
    mod = types.ModuleType("fake_forge_policy_mod")

    class NoPush:
        async def check(self, request):
            return Decision.deny("no pushes") if request.is_push else Decision.allow()

    mod.factory = NoPush
    mod.instance = NoPush()
    monkeypatch.setitem(sys.modules, "fake_forge_policy_mod", mod)
    assert isinstance(load_policy("fake_forge_policy_mod:factory"), NoPush)
    assert load_policy("fake_forge_policy_mod:instance") is mod.instance
    assert load_policy("") is ALLOW_ALL
    with pytest.raises(ValueError):
        load_policy("no-colon")


# -- the http-proxy runs the same hook ---------------------------------------

def _github_provider(policy) -> Provider:
    return Provider(
        name="github",
        credential=StaticTokenSource(token="ghs_real"),
        transports=[
            ForgeHosts(hosts=[ForgeHost("api.github.com", api_prefixes=("/",))], dialect=_Dialect()),
            HttpProxy(upstream="https://api.github.com"),
        ],
        forge_policy=policy,
    )


def test_api_forge_request_reads_repo_and_graphql():
    p = _github_provider(None)
    fr = api_forge_request(p, IDENT, via="mcp", method="post",
                           url=httpx.URL("https://api.github.com/graphql"),
                           body=b'{"query": "mutation { mergePullRequest(input: {}) { x } }"}')
    assert fr.kind == "api" and fr.graphql[0].fields == ("mergePullRequest",) and fr.is_mutation
    fr = api_forge_request(p, IDENT, via="http-proxy", method="GET",
                           url=httpx.URL("https://api.github.com/repos/o/r/pulls?state=open"))
    assert (fr.repo, fr.query) == ("o/r", "state=open")
    no_forge = Provider(name="jira", transports=[])
    assert api_forge_request(no_forge, IDENT, via="mcp", method="GET", url=httpx.URL("https://x/y")) is None


def test_graphql_body_rides_along():
    body = b'{"query": "query { viewer { login } }", "variables": {"owner": "o"}}'
    p = _github_provider(None)
    fr = api_forge_request(p, IDENT, via="mcp", method="POST",
                           url=httpx.URL("https://api.github.com/graphql"), body=body)
    assert fr.graphql_body == body
    rest = api_forge_request(p, IDENT, via="mcp", method="GET", url=httpx.URL("https://api.github.com/repos/o/r"))
    assert rest.graphql_body is None


def test_http_proxy_denial_never_reaches_upstream(monkeypatch):
    class DenyDeletes:
        async def check(self, request):
            return Decision.deny("no deletes") if request.method == "DELETE" else Decision.allow()

    sent: list[httpx.Request] = []

    async def fake_send(self, request, **kw):
        sent.append(request)
        return httpx.Response(200, json={"ok": True}, request=request)

    monkeypatch.setattr(httpx.AsyncClient, "send", fake_send)
    provider = _github_provider(DenyDeletes())
    app = FastAPI()

    async def authed() -> Identity:
        return IDENT

    for t in provider.transports:
        app.include_router(t.routes(provider, authed=authed), prefix="/github")
    client = TestClient(app)

    resp = client.delete("/github/repos/o/r")
    assert resp.status_code == 403
    assert resp.headers[DENY_HEADER] == "no deletes"
    assert "forge policy" in resp.json()["message"]
    assert sent == []

    resp = client.get("/github/repos/o/r")
    assert resp.status_code == 200
    assert sent[0].headers["authorization"] == "Bearer ghs_real"
