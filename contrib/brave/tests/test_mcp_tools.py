"""Brave's `brave_web_search` tool (issue #700, porting PR #698).

The assertions that matter are the ones that keep the THREE OUTCOMES distinct. The
implementation this replaces answered a real query with HTTP 200 and "no instant
answer", so an agent could not tell an empty web from the wrong API — and an agent
told "no results" retries the query, while one told "HTTP 401" reports a broken key.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from scooter_broker_lib.mcp import ToolContext, gate_for
from scooter_broker_lib.search import MAX_RESULTS
from scooter_broker_lib.types import Identity, Provider

from scooter_contrib_brave import mcp_tools as brave_tools
from scooter_contrib_brave.broker_provider import brave


@dataclass
class FakeUpstream:
    response: httpx.Response
    calls: list[dict[str, Any]] = field(default_factory=list)

    async def request(self, method: str, path: str, **kw: Any) -> httpx.Response:
        self.calls.append({"method": method, "path": path, **kw})
        return self.response


@dataclass
class FakeLinks:
    async def list(self) -> list[dict[str, Any]]:
        return []


def _ctx(response: httpx.Response) -> ToolContext:
    return ToolContext(
        identity=Identity(
            conversation_id="conv-1",
            namespace="agent-sandbox",
            service_account="system:serviceaccount:agent-sandbox:agent-host",
        ),
        provider=Provider(name="brave", transports=[]),
        upstream=FakeUpstream(response),
        links=FakeLinks(),
    )


def _fn(name: str):
    """The registered tool, called with kwargs — the shape contrib/slack's tests use."""
    return getattr(brave_tools, name)


def _results(*rows: dict) -> httpx.Response:
    return httpx.Response(200, json={"web": {"results": list(rows)}})


async def test_renders_each_hit_with_its_snippet():
    ctx = _ctx(
        _results(
            {"title": "Kagi API", "url": "https://kagi.com/api", "description": "The API docs."},
            {"title": "Pricing", "url": "https://kagi.com/pricing"},
        )
    )
    out = await _fn("brave_web_search")(query="kagi api", ctx=ctx)
    assert not out.is_error
    assert out.text == (
        'Results for "kagi api":\n'
        "- Kagi API (https://kagi.com/api)\n"
        "  The API docs.\n"
        "- Pricing (https://kagi.com/pricing)"
    )


async def test_sends_the_query_and_no_credential_of_its_own():
    """The tool asks for a search; the BROKER adds the key on the way out.

    A key the tool put in `params` would be copied into every access log the request
    passes — the reason brave's credential is a header source (PR #698).
    """
    ctx = _ctx(_results())
    await _fn("brave_web_search")(query="some query", ctx=ctx)
    call = ctx.upstream.calls[0]
    assert call["method"] == "GET"
    assert call["path"] == "res/v1/web/search"
    assert call["params"] == {"q": "some query", "count": MAX_RESULTS}
    assert "X-Subscription-Token" not in call.get("headers", {})


async def test_an_upstream_failure_is_reported_VERBATIM_not_as_no_results():
    ctx = _ctx(httpx.Response(429, text="Request rate limit exceeded"))
    out = await _fn("brave_web_search")(query="anything", ctx=ctx)
    assert out.is_error
    assert "429" in out.text
    assert "Request rate limit exceeded" in out.text
    assert "brave" in out.text  # which provider's quota, so the operator knows where to look


async def test_an_empty_web_is_SUCCESS_and_names_the_provider():
    ctx = _ctx(_results())
    out = await _fn("brave_web_search")(query="a query nothing matches", ctx=ctx)
    assert not out.is_error
    assert out.text == 'No results for "a query nothing matches" (via brave).'


async def test_a_row_with_no_url_is_dropped():
    """A hit the agent cannot follow is not a result."""
    ctx = _ctx(_results({"title": "no link here"}, {"title": "ok", "url": "https://x.test"}))
    out = await _fn("brave_web_search")(query="q", ctx=ctx)
    assert [line for line in out.text.splitlines() if line.startswith("- ")] == [
        "- ok (https://x.test)"
    ]


async def test_the_result_list_is_capped():
    rows = [{"title": f"r{i}", "url": f"https://x.test/{i}"} for i in range(MAX_RESULTS + 5)]
    out = await _fn("brave_web_search")(query="q", ctx=_ctx(_results(*rows)))
    assert len([line for line in out.text.splitlines() if line.startswith("- ")]) == MAX_RESULTS


async def test_a_blank_query_fails_without_calling_upstream():
    ctx = _ctx(_results())
    out = await _fn("brave_web_search")(query="   ", ctx=ctx)
    assert out.is_error
    assert ctx.upstream.calls == []


async def test_a_malformed_body_is_no_results_rather_than_a_crash():
    """A 200 whose body is not the documented shape must not raise through the tool
    layer — the agent gets an answer either way."""
    out = await _fn("brave_web_search")(query="q", ctx=_ctx(httpx.Response(200, json=[1, 2, 3])))
    assert not out.is_error
    assert "No results" in out.text


# --- the provider wiring ----------------------------------------------------------

def test_the_key_is_delivered_as_a_header_never_a_query_param(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "BSA-secret")
    provider = brave()
    assert provider.enabled
    assert provider.credential.kind == "header"
    assert provider.credential.header_name == "X-Subscription-Token"
    assert provider.credential.token == "BSA-secret"


def test_no_key_means_no_provider_so_the_tool_is_never_listed(monkeypatch):
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "")
    assert brave().enabled is False


def test_it_ships_tools_and_NO_raw_proxy_route(monkeypatch):
    """A /brave/* passthrough would let the agent burn the search quota on arbitrary
    paths while adding nothing the typed tool does not do."""
    monkeypatch.setenv("BRAVE_SEARCH_API_KEY", "k")
    transports = brave().transports
    assert [t.name for t in transports] == ["mcp-tools"]
    assert transports[0].upstream == brave_tools.UPSTREAM


def test_brave_web_search_is_not_attachment_gated():
    """Search has no resource to be attached to; its gate is the provider's `enabled`.
    A gate here would hide it from every conversation."""
    assert gate_for("brave_web_search") is None


async def test_the_tool_is_named_for_its_provider_so_a_sibling_can_coexist():
    """The name is the whole reason several search providers can be enabled at once.

    Tool names are flat and global — the broker refuses to start on a duplicate
    (broker/mcp/routes.py) — so a bare `web_search` would make brave and every
    sibling search contrib mutually exclusive. That exclusivity was an artifact of the
    name, not a real constraint; nothing stops a deployment from wanting two indexes.
    Asserted against the SERVER's registry, because that is the name the agent is shown.
    """
    names = {t.name for t in await brave_tools.mcp.list_tools(run_middleware=False)}
    assert names == {"brave_web_search"}
