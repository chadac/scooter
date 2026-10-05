"""DuckDuckGo's `duckduckgo_web_search` tool (asked for in review of PR #707).

The provider with no key, and therefore the one a deployment can always have. The
assertions that matter are the three outcomes of a 200: results, DDG's own "no results",
and a page this scraper cannot read — which must be a FAILURE. PR #698 removed a
DuckDuckGo-backed tool precisely because it reported a non-answer as an empty web, and
re-adding DuckDuckGo would be worth nothing if it re-added that.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from scooter_broker_lib.mcp import ToolContext, gate_for
from scooter_broker_lib.types import Identity, Provider

from scooter_contrib_duckduckgo import mcp_tools as ddg_tools
from scooter_contrib_duckduckgo.broker_provider import duckduckgo


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
        provider=Provider(name="duckduckgo", transports=[]),
        upstream=FakeUpstream(response),
        links=FakeLinks(),
    )


def _fn(name: str):
    return getattr(ddg_tools, name)


def _page(*results: str) -> httpx.Response:
    return httpx.Response(200, text=f"<html><body>{''.join(results)}</body></html>")


def _result(url: str, title: str, snippet: str) -> str:
    return (
        f'<h2 class="result__title"><a class="result__a" href="{url}">{title}</a></h2>'
        f'<a class="result__snippet" href="{url}">{snippet}</a>'
    )


async def test_renders_each_hit_with_its_snippet():
    ctx = _ctx(
        _page(
            _result("https://kagi.com/api", "Kagi API", "The API docs."),
            _result("https://kagi.com/pricing", "Pricing", "What it costs."),
        )
    )
    out = await _fn("duckduckgo_web_search")(query="kagi api", ctx=ctx)
    assert not out.is_error
    assert out.text == (
        'Results for "kagi api":\n'
        "- Kagi API (https://kagi.com/api)\n"
        "  The API docs.\n"
        "- Pricing (https://kagi.com/pricing)\n"
        "  What it costs."
    )


async def test_it_asks_for_the_html_page_with_a_browser_user_agent_and_no_region():
    """The no-JS page refuses a programmatic user agent, so the UA is load-bearing
    rather than cosmetic — and `kl=wt-wt` keeps results from being localized by whatever
    egress IP the cluster happens to have."""
    ctx = _ctx(_page())
    await _fn("duckduckgo_web_search")(query="some query", ctx=ctx)
    call = ctx.upstream.calls[0]
    assert call["method"] == "GET" and call["path"] == "html/"
    assert call["params"] == {"q": "some query", "kl": "wt-wt"}
    assert "Mozilla/5.0" in call["headers"]["User-Agent"]
    # No credential of its own: there is nothing to inject, and the tool must not invent
    # an auth header that would make this look like an authenticated API.
    assert "Authorization" not in call["headers"]


async def test_an_upstream_failure_is_reported_VERBATIM():
    out = await _fn("duckduckgo_web_search")(
        query="q", ctx=_ctx(httpx.Response(429, text="too many requests"))
    )
    assert out.is_error
    assert "429" in out.text and "too many requests" in out.text and "duckduckgo" in out.text


async def test_the_BOT_CHECK_page_is_a_failure_not_an_empty_web():
    """A 200 carrying DDG's anomaly page is the exact shape of the #698 bug. The agent
    has to hear "rate-limited", because an agent told "no results" retries the query and
    then reports that the web has nothing."""
    out = await _fn("duckduckgo_web_search")(
        query="q", ctx=_ctx(httpx.Response(200, text="<script src='/dist/anomaly.js'>"))
    )
    assert out.is_error
    assert "rate-limited" in out.text
    assert "No results" not in out.text


async def test_ddgs_own_no_results_notice_IS_a_successful_empty_search():
    out = await _fn("duckduckgo_web_search")(
        query="asdkjhasd", ctx=_ctx(httpx.Response(200, text='<div class="no-results">No results.</div>'))
    )
    assert not out.is_error
    assert out.text == 'No results for "asdkjhasd" (via duckduckgo).'


async def test_an_UNREADABLE_page_is_a_failure_that_says_the_scraper_broke():
    """DDG owes this provider no stability, so the page changing shape is a question of
    when. It must read as "this tool is broken", not as "the web is empty"."""
    out = await _fn("duckduckgo_web_search")(
        query="q", ctx=_ctx(httpx.Response(200, text="<html><body><h1>Hotel WiFi</h1></body></html>"))
    )
    assert out.is_error
    assert "shape changed" in out.text and "not empty" in out.text


async def test_a_blank_query_fails_without_calling_upstream():
    ctx = _ctx(_page())
    out = await _fn("duckduckgo_web_search")(query="   ", ctx=ctx)
    assert out.is_error and ctx.upstream.calls == []


# --- the provider wiring ----------------------------------------------------------

def test_the_gate_is_an_explicit_FLAG_because_there_is_no_key(monkeypatch):
    """Every other search provider gates on its key being present. This one has no key,
    so nothing's absence could mean "off" — and defaulting it on would have each
    deployment that merely BUILDS this contrib start scraping DuckDuckGo."""
    monkeypatch.delenv("DUCKDUCKGO_ENABLED", raising=False)
    assert duckduckgo().enabled is False
    monkeypatch.setenv("DUCKDUCKGO_ENABLED", "true")
    assert duckduckgo().enabled is True


def test_it_carries_NO_credential(monkeypatch):
    """The broker is not only a secret vault: this provider is here for the tool surface
    and the egress path, with nothing to inject."""
    monkeypatch.setenv("DUCKDUCKGO_ENABLED", "true")
    assert duckduckgo().credential is None


def test_it_ships_tools_and_NO_raw_proxy_route(monkeypatch):
    """A /duckduckgo/* passthrough would be a second way to reach the same page with
    none of the parsing — and the parsing is the only thing standing between the agent
    and a bot-check page that looks like an empty web."""
    monkeypatch.setenv("DUCKDUCKGO_ENABLED", "true")
    transports = duckduckgo().transports
    assert [t.name for t in transports] == ["mcp-tools"]
    assert transports[0].upstream == ddg_tools.UPSTREAM


def test_duckduckgo_web_search_is_not_attachment_gated():
    assert gate_for("duckduckgo_web_search") is None


async def test_the_tool_is_named_for_its_provider_so_a_sibling_can_coexist():
    """Three search providers, three tools: the name is what makes that possible
    (broker/mcp/routes.py refuses to start on a duplicate)."""
    names = {t.name for t in await ddg_tools.mcp.list_tools(run_middleware=False)}
    assert names == {"duckduckgo_web_search"}
