"""The catalog and registry routes; entries must pass form validation."""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient, MockTransport

from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_mcpservers.catalog import catalog
from scooter_contrib_mcpservers.registry import MAX_RESULTS, RegistrySearch
from scooter_contrib_mcpservers.store import validate
from scooter_contrib_mcpservers.transport import McpServers


def test_every_entry_would_pass_the_form():
    for e in catalog():
        validate(e["name"], e["kind"], e["spec"], tuple(e.get("args", ())))


def test_names_are_unique_and_the_open_set_is_the_promised_size():
    names = [e["name"] for e in catalog()]
    assert len(names) == len(set(names))
    open_entries = [e for e in catalog() if not e.get("needs_api_key")]
    assert 20 <= len(open_entries) <= 25


def make_app(registry: RegistrySearch | None = None) -> FastAPI:
    transport = McpServers(registry=registry)
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    a.include_router(
        transport.routes(Provider(name="mcpservers", transports=[transport]), authed), prefix="/mcpservers"
    )
    a.state.caller = caller
    return a


def client(app: FastAPI, *, user: str | None = "alice") -> AsyncClient:
    app.state.caller["identity"] = Identity(
        conversation_id="", namespace="ns", service_account="sa", relayed_user=user
    )
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


async def test_catalog_route_needs_the_relay_and_serves_the_file():
    app = make_app()
    async with client(app, user=None) as c:
        assert (await c.get("/mcpservers/user/catalog")).status_code == 403
    async with client(app) as c:
        assert (await c.get("/mcpservers/user/catalog")).json()["servers"] == catalog()


def registry_payload() -> dict:
    def srv(name, packages):
        return {"server": {"name": name, "description": f"about {name}", "packages": packages}}

    stdio = {"transport": {"type": "stdio"}}
    return {
        "servers": [
            srv("io.github.microsoft/playwright-mcp", [{"registryType": "npm", "identifier": "@playwright/mcp", **stdio}]),
            # Remote-only: no packages at all.
            {"server": {"name": "ai.remote/only", "description": "remote", "remotes": [{"type": "sse"}]}},
            # An identifier the form would refuse.
            srv("bad.spec/x", [{"registryType": "npm", "identifier": "not a package!", **stdio}]),
            # http transport, not runnable as a unit.
            srv("http.only/x", [{"registryType": "npm", "identifier": "http-pkg", "transport": {"type": "streamable-http"}}]),
            srv("keyed.pypi/x", [{
                "registryType": "pypi", "identifier": "keyed-pkg", **stdio,
                "environmentVariables": [{"name": "API_KEY", "isRequired": True, "isSecret": True}],
            }]),
            # A duplicate of the first package.
            srv("fork.of/playwright", [{"registryType": "npm", "identifier": "@playwright/mcp", **stdio}]),
        ]
    }


def counting_registry(payload: dict | Exception) -> tuple[RegistrySearch, list[httpx.Request]]:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if isinstance(payload, Exception):
            raise payload
        return httpx.Response(200, json=payload)

    return RegistrySearch(client=AsyncClient(transport=MockTransport(handler))), calls


async def test_registry_search_maps_filters_and_flags():
    registry, calls = counting_registry(registry_payload())
    app = make_app(registry)
    async with client(app) as c:
        rows = (await c.get("/mcpservers/user/registry", params={"q": "playwright"})).json()["servers"]
    assert calls[0].url.params["version"] == "latest"
    assert [r["spec"] for r in rows] == ["@playwright/mcp", "keyed-pkg"]
    assert rows[0] == {
        "registry_name": "io.github.microsoft/playwright-mcp", "kind": "npm", "spec": "@playwright/mcp",
        "description": "about io.github.microsoft/playwright-mcp", "needs_api_key": False,
    }
    assert rows[1]["kind"] == "pypi" and rows[1]["needs_api_key"] is True


async def test_registry_search_caches_a_query():
    registry, calls = counting_registry(registry_payload())
    app = make_app(registry)
    async with client(app) as c:
        for _ in range(2):
            assert (await c.get("/mcpservers/user/registry", params={"q": "pw"})).status_code == 200
    assert len(calls) == 1


async def test_registry_search_caps_results():
    payload = {"servers": [
        {"server": {"name": f"a.b/x{i}", "description": "d",
                    "packages": [{"registryType": "pypi", "identifier": f"pkg{i}", "transport": {"type": "stdio"}}]}}
        for i in range(MAX_RESULTS + 5)
    ]}
    registry, _ = counting_registry(payload)
    app = make_app(registry)
    async with client(app) as c:
        rows = (await c.get("/mcpservers/user/registry", params={"q": "pkg"})).json()["servers"]
    assert len(rows) == MAX_RESULTS


async def test_registry_errors_are_a_502_and_bad_queries_a_400():
    registry, _ = counting_registry(httpx.ConnectError("boom"))
    app = make_app(registry)
    async with client(app) as c:
        assert (await c.get("/mcpservers/user/registry", params={"q": "pw"})).status_code == 502
        assert (await c.get("/mcpservers/user/registry", params={"q": " x "})).status_code == 400
        assert (await c.get("/mcpservers/user/registry")).status_code == 400
    async with client(make_app()) as c:
        assert (await c.get("/mcpservers/user/registry", params={"q": "pw"})).status_code == 503
