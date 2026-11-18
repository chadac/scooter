"""databricks: one provider per workspace, the intercepted host, and the per-request token file."""

from __future__ import annotations

import importlib

import httpx

import pytest

from scooter_broker_lib import registry
from scooter_broker_lib.forge import find_forge_hosts
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity

IDENT = Identity(conversation_id="c", namespace="ns", service_account="sa")


@pytest.fixture
def mod(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABRICKS_WORKSPACES", '{"dev": "https://dev.cloud.databricks.com/", "uat": "https://uat.cloud.databricks.com"}')
    monkeypatch.setenv("DATABRICKS_TOKENS_DIR", str(tmp_path))
    import scooter_contrib_databricks.broker_provider as m
    return importlib.reload(m), tmp_path


def test_a_factory_per_workspace_plus_a_disabled_placeholder(mod):
    m, _ = mod
    assert {"databricks_dev", "databricks_uat"} <= set(registry._REGISTRY)
    assert m.databricks().enabled is False
    dev = registry._REGISTRY["databricks_dev"]()
    assert dev.enabled and dev.name == "databricks-dev"
    (h,) = find_forge_hosts(dev).hosts
    assert (h.host, h.api_prefixes) == ("dev.cloud.databricks.com", ("/api/",))
    (proxy,) = [t for t in dev.transports if isinstance(t, HttpProxy)]
    assert proxy.upstream == "https://dev.cloud.databricks.com"


async def test_token_is_reread_on_every_request(mod):
    _, d = mod
    p = registry._REGISTRY["databricks_uat"]()
    missing = await p.credential.get(IDENT)
    req = httpx.Request("GET", "https://uat.cloud.databricks.com/api/2.0/x")
    missing.inject(req)
    assert "authorization" not in req.headers
    (d / "uat").write_text("tok1\n")
    assert (await p.credential.get(IDENT)).value == "tok1"
    (d / "uat").write_text("tok2")
    cred = await p.credential.get(IDENT)
    assert (cred.kind, cred.value) == ("bearer", "tok2")
