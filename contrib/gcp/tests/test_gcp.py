"""GCP provider: host normalisation, enable gating, the service-account token, and the forge proxy end to end."""

from __future__ import annotations

import json
import logging
import ssl
from types import SimpleNamespace

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from broker.forge.ca import LeafIssuer, generate_ca
from broker.forge.proxy import ForgeProxy, build_routes
from scooter_broker_lib.forge import AllowAll, Decision, ForgeHosts
from scooter_broker_lib.types import Identity
from scooter_contrib_gcp import service_account as sa_mod
from scooter_contrib_gcp.broker_provider import gcp
from scooter_contrib_gcp.config import DEFAULT_HOSTS, GcpSettings, full_host
from scooter_contrib_gcp.service_account import ServiceAccountSource

_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
_PEM = _KEY.private_bytes(
    serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()
).decode()

INFO = {
    "type": "service_account",
    "client_email": "scooter@proj.iam.gserviceaccount.com",
    "private_key": _PEM,
    "private_key_id": "kid123",
    "token_uri": "https://oauth2.googleapis.com/token",
}
IDENT = Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for k in ("GCP_SERVICE_ACCOUNT_JSON", "GCP_SCOPES", "GCP_EXTRA_HOSTS", "GCP_FORGE_POLICY"):
        monkeypatch.delenv(k, raising=False)


class _FakeTokenEndpoint:
    """Stands in for httpx.AsyncClient, recording the assertions posted to the token URI."""

    calls: list[dict] = []

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, data):
        _FakeTokenEndpoint.calls.append({"url": url, **data})
        n = len(_FakeTokenEndpoint.calls)
        return httpx.Response(200, json={"access_token": f"ya29.tok{n}", "expires_in": 3599},
                              request=httpx.Request("POST", url))


@pytest.fixture
def token_endpoint(monkeypatch):
    _FakeTokenEndpoint.calls = []
    # Only the source's httpx, so the test's own clients stay real.
    monkeypatch.setattr(sa_mod, "httpx", SimpleNamespace(AsyncClient=_FakeTokenEndpoint))
    return _FakeTokenEndpoint


# -- hosts -------------------------------------------------------------------

def test_full_host_expands_bare_names_and_keeps_full_ones():
    assert full_host("compute") == "compute.googleapis.com"
    assert full_host("US-Central1-Run.googleapis.com.") == "us-central1-run.googleapis.com"


@pytest.mark.parametrize("bad", ["evil.example.com", "googleapis.com", "compute.googleapis.com.evil.io"])
def test_full_host_refuses_anything_outside_googleapis(bad):
    with pytest.raises(ValueError):
        full_host(bad)


def test_extra_hosts_extend_the_defaults_without_duplicates(monkeypatch):
    monkeypatch.setenv("GCP_EXTRA_HOSTS", "aiplatform, compute us-central1-run.googleapis.com")
    hosts = GcpSettings().hosts
    assert len(hosts) == len(DEFAULT_HOSTS) + 2
    assert {"aiplatform.googleapis.com", "us-central1-run.googleapis.com", "compute.googleapis.com"} <= set(hosts)


# -- provider ----------------------------------------------------------------

def _forge(provider) -> ForgeHosts:
    return next(t for t in provider.transports if isinstance(t, ForgeHosts))


def test_disabled_without_a_key_logs_no_error(caplog):
    with caplog.at_level(logging.INFO, logger="scooter_contrib_gcp"):
        assert gcp().enabled is False
    assert [r.levelno for r in caplog.records] == [logging.INFO]


def test_a_key_that_is_not_json_logs_an_error(monkeypatch, caplog):
    monkeypatch.setenv("GCP_SERVICE_ACCOUNT_JSON", "{not json")
    with caplog.at_level(logging.INFO, logger="scooter_contrib_gcp"):
        assert gcp().enabled is False
    assert [r.levelno for r in caplog.records] == [logging.ERROR]


def test_disabled_with_a_key_missing_fields(monkeypatch):
    monkeypatch.setenv("GCP_SERVICE_ACCOUNT_JSON", json.dumps({"client_email": "x@y"}))
    assert gcp().enabled is False


def test_enabled_with_a_key_and_every_host_is_api_only(monkeypatch):
    monkeypatch.setenv("GCP_SERVICE_ACCOUNT_JSON", json.dumps(INFO))
    provider = gcp()
    assert provider.enabled is True
    hosts = _forge(provider).hosts
    assert {h.host for h in hosts} == set(GcpSettings().hosts)
    assert all(h.api_prefixes == ("/",) and not h.git for h in hosts)
    assert isinstance(provider.forge_policy, AllowAll)


def test_a_non_google_extra_host_disables_the_provider(monkeypatch):
    monkeypatch.setenv("GCP_SERVICE_ACCOUNT_JSON", json.dumps(INFO))
    monkeypatch.setenv("GCP_EXTRA_HOSTS", "evil.example.com")
    provider = gcp()
    assert provider.enabled is False
    assert _forge(provider).hosts == []


def test_forge_policy_is_loaded_from_env(monkeypatch):
    monkeypatch.setenv("GCP_FORGE_POLICY", "scooter_broker_lib.forge.policy:AllowAll")
    assert isinstance(gcp().forge_policy, AllowAll)


# -- token -------------------------------------------------------------------

async def test_token_is_minted_with_cloud_platform_and_cached(token_endpoint):
    source = ServiceAccountSource(info=INFO, scopes=GcpSettings().scopes)
    first = await source.get(IDENT)
    second = await source.get(IDENT)
    assert first.kind == "bearer" and first.value == second.value == "ya29.tok1"
    assert len(token_endpoint.calls) == 1
    claims = jwt.decode(token_endpoint.calls[0]["assertion"], _KEY.public_key(),
                        algorithms=["RS256"], audience=INFO["token_uri"])
    assert claims["iss"] == INFO["client_email"]
    assert claims["scope"] == "https://www.googleapis.com/auth/cloud-platform"
    assert "sub" not in claims


async def test_an_expiring_token_is_refreshed(token_endpoint):
    source = ServiceAccountSource(info=INFO, scopes=["s"])
    await source.get(IDENT)
    source._cached = (source._cached[0], 0.0)
    assert (await source.get(IDENT)).value == "ya29.tok2"


# -- through the forge proxy -------------------------------------------------

class _Unread(httpx.AsyncByteStream):
    """A body still to be streamed, as the proxy's aiter_raw needs."""

    def __init__(self, data: bytes) -> None:
        self.data = data

    async def __aiter__(self):
        yield self.data


class _DenyWrites:
    async def check(self, request):
        return Decision.deny("read-only") if request.is_mutation else Decision.allow()


@pytest.fixture
async def proxied(monkeypatch, token_endpoint):
    monkeypatch.setenv("GCP_SERVICE_ACCOUNT_JSON", json.dumps(INFO))
    provider = gcp()
    provider.forge_policy = _DenyWrites()
    routes = build_routes([provider])
    ca = generate_ca(sorted(routes))
    seen: list[httpx.Request] = []

    async def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        body = b'{"items": []}'
        return httpx.Response(200, headers={"content-type": "application/json", "content-length": str(len(body))},
                              stream=_Unread(body))

    async def authenticate(token: str) -> Identity:
        return IDENT

    proxy = ForgeProxy(routes, LeafIssuer(ca), authenticate,
                       upstream=httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
    await proxy.start("127.0.0.1", 0)
    client = httpx.AsyncClient(
        proxy=httpx.Proxy(f"http://127.0.0.1:{proxy.port}", headers={"Proxy-Authorization": "Bearer sa"}),
        verify=ssl.create_default_context(cadata=ca.cert_pem.decode()),
    )
    yield client, seen
    await client.aclose()
    await proxy.close()


async def test_placeholder_is_replaced_by_the_service_account_token(proxied):
    client, seen = proxied
    r = await client.get("https://compute.googleapis.com/compute/v1/projects/p/aggregated/instances",
                         headers={"Authorization": "Bearer scooter-forge-proxy"})
    assert r.status_code == 200 and r.json() == {"items": []}
    assert [req.headers["authorization"] for req in seen] == ["Bearer ya29.tok1"]


async def test_gsutils_api_key_is_dropped(proxied):
    client, seen = proxied
    r = await client.get("https://storage.googleapis.com/storage/v1/b?project=p&key=AIzaX&alt=json")
    assert r.status_code == 200
    assert seen[0].url.params.multi_items() == [("project", "p"), ("alt", "json")]
    assert seen[0].headers["authorization"] == "Bearer ya29.tok1"


async def test_the_policy_runs_before_any_upstream_call(proxied):
    client, seen = proxied
    r = await client.delete("https://compute.googleapis.com/compute/v1/projects/p/zones/z/instances/vm")
    assert r.status_code == 403
    assert r.headers["x-scooter-policy"] == "read-only"
    assert seen == []


async def test_an_unlisted_host_is_not_intercepted(proxied):
    client, _ = proxied
    with pytest.raises(httpx.ProxyError):
        await client.get("https://example.googleapis.com/v1/x")
