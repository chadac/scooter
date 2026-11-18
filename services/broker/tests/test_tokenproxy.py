"""tokenproxy providers: one per TOKENPROXY_PROVIDERS entry, its intercepted host, and its re-read token."""

from __future__ import annotations

import importlib
import json

import httpx
import pytest

from scooter_broker_lib import registry
from scooter_broker_lib.forge import find_forge_hosts
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity

IDENT = Identity(conversation_id="c", namespace="ns", service_account="sa")

PROVIDERS = {
    "billing": {"url": "https://billing.example.com/", "apiPrefixes": ["/v1/"], "credential": {"kind": "bearer"}},
    "metrics": {"url": "https://metrics.example.com", "apiPrefixes": ["/"],
                "credential": {"kind": "header", "headerName": "X-Api-Key"}},
    "inventory": {"url": "http://inventory.tools.svc.cluster.local:8080", "apiPrefixes": ["/"],
                  "credential": {"kind": "none"}},
}


@pytest.fixture
def tokens(monkeypatch, tmp_path):
    from broker.config import settings
    import broker.providers.tokenproxy as m

    monkeypatch.setattr(settings, "tokenproxy_providers", json.dumps(PROVIDERS))
    monkeypatch.setattr(settings, "tokenproxy_dir", str(tmp_path))
    importlib.reload(m)
    try:
        yield tmp_path
    finally:
        for name in PROVIDERS:
            registry._REGISTRY.pop(f"tokenproxy:{name}", None)


def build(name: str):
    return registry._REGISTRY[f"tokenproxy:{name}"]()


def test_a_provider_per_entry_named_for_its_contrib(tokens):
    p = build("billing")
    assert p.enabled and p.name == "billing"
    (h,) = find_forge_hosts(p).hosts
    assert (h.host, h.api_prefixes) == ("billing.example.com", ("/v1/",))
    (proxy,) = [t for t in p.transports if isinstance(t, HttpProxy)]
    assert proxy.upstream == "https://billing.example.com"


def test_plain_http_skips_the_forge_proxy(tokens):
    p = build("inventory")
    assert find_forge_hosts(p) is None
    (proxy,) = p.transports
    assert isinstance(proxy, HttpProxy) and proxy.upstream == "http://inventory.tools.svc.cluster.local:8080"


async def test_kind_none_sends_no_credential(tokens):
    req = httpx.Request("GET", "http://inventory.tools.svc.cluster.local:8080/items")
    (await build("inventory").credential.get(IDENT)).inject(req)
    assert "authorization" not in req.headers


def test_none_without_config(monkeypatch):
    from broker.config import settings
    import broker.providers.tokenproxy as m

    monkeypatch.setattr(settings, "tokenproxy_providers", "{}")
    importlib.reload(m)
    assert not [k for k in registry._REGISTRY if k.startswith("tokenproxy:")]


async def test_token_is_reread_and_sent_in_the_configured_header(tokens):
    p = build("metrics")
    req = httpx.Request("GET", "https://metrics.example.com/q")
    (await p.credential.get(IDENT)).inject(req)
    assert "x-api-key" not in req.headers

    (tokens / "metrics").mkdir()
    (tokens / "metrics" / "token").write_text("k1\n")
    assert (await p.credential.get(IDENT)).value == "k1"
    (tokens / "metrics" / "token").write_text("k2")
    req = httpx.Request("GET", "https://metrics.example.com/q")
    (await p.credential.get(IDENT)).inject(req)
    assert req.headers["x-api-key"] == "k2" and "authorization" not in req.headers


def test_mounts_under_its_name(tokens):
    from broker.core.app import create_app

    paths = create_app().openapi()["paths"]
    assert any(p.startswith("/billing/") for p in paths), f"mounted: {sorted(paths)}"


E2E = """
import httpx
from fastapi.testclient import TestClient

from broker.core.app import create_app
from broker.core.auth import authenticate
from scooter_broker_lib.types import Identity

seen = {}
real = httpx.AsyncClient

def handler(req):
    seen.update(url=str(req.url), auth=req.headers.get("authorization"))
    return httpx.Response(200, json={"ok": True})

httpx.AsyncClient = lambda **kw: real(transport=httpx.MockTransport(handler), **kw)
app = create_app()
app.dependency_overrides[authenticate] = lambda: Identity(conversation_id="c", namespace="ns", service_account="sa")
resp = TestClient(app).get("/billing/v1/invoices")
assert resp.status_code == 200, (resp.status_code, resp.text)
print(seen["url"], seen["auth"])
"""


def test_create_app_alone_serves_it_end_to_end(tmp_path):
    # A fresh interpreter, so nothing in this test process has imported or reloaded the module.
    import os
    import subprocess
    import sys

    (tmp_path / "billing").mkdir()
    (tmp_path / "billing" / "token").write_text("s3cret\n")
    env = {**os.environ, "TOKENPROXY_PROVIDERS": json.dumps({"billing": PROVIDERS["billing"]}),
           "TOKENPROXY_DIR": str(tmp_path)}
    out = subprocess.run([sys.executable, "-c", E2E], env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "https://billing.example.com/v1/invoices Bearer s3cret"
