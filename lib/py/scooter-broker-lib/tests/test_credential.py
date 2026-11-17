"""An empty credential sends no auth header, so the upstream's own 401 reaches the agent."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_broker_lib.forge.hosts import ForgeHosts
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Credential, Identity, Provider

IDENT = Identity(conversation_id="c1", namespace="ns", service_account="system:serviceaccount:ns:sandbox-c1")


def _req() -> httpx.Request:
    return httpx.Request("GET", "https://example.com/x")


@pytest.mark.parametrize("value", ["", "  "])
@pytest.mark.parametrize("kind", ["bearer", "basic", "header"])
def test_empty_value_adds_no_header(kind, value):
    req = _req()
    Credential(kind=kind, value=value, meta={"header_name": "PRIVATE-TOKEN"}).inject(req)
    assert "authorization" not in req.headers and "private-token" not in req.headers


def test_multi_header_skips_empty_values():
    req = _req()
    Credential(kind="multi-header", value=json.dumps({"X-A": "a", "X-B": "", "X-C": " "})).inject(req)
    assert req.headers["x-a"] == "a" and "x-b" not in req.headers and "x-c" not in req.headers


def test_non_empty_bearer_still_injected():
    req = _req()
    Credential(kind="bearer", value="tok").inject(req)
    assert req.headers["authorization"] == "Bearer tok"


def test_inject_git_empty_adds_no_header():
    req = _req()
    ForgeHosts().inject_git(req, Credential(kind="bearer", value=""))
    assert "authorization" not in req.headers


class _Upstream(BaseHTTPRequestHandler):
    def do_GET(self):
        status = 200 if self.headers.get("Authorization") else 401
        body = json.dumps({"message": "upstream says " + str(status)}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture
def upstream():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Upstream)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


class _EmptySource:
    async def get(self, identity, request=None):
        return Credential(kind="bearer", value="")


def test_http_proxy_passes_upstream_401_for_empty_credential(upstream):
    provider = Provider(name="gitlab", transports=[HttpProxy(upstream=upstream)], credential=_EmptySource())

    async def authed() -> Identity:
        return IDENT

    app = FastAPI()
    app.include_router(provider.transports[0].routes(provider, authed=authed), prefix="/gitlab")
    resp = TestClient(app).get("/gitlab/api/v4/user")

    assert (resp.status_code, resp.json()) == (401, {"message": "upstream says 401"})
