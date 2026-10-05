"""Kagi's `kagi_web_search` tool (issue #700, porting PR #698).

Kagi's own quirk is the one to protect: its result rows are TYPED, and the row that is
not a result carries no url. Everything else about search behaviour is shared with
brave and tested once, against the shared helpers
(lib/py/scooter-broker-lib/tests/test_search.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.search import MAX_RESULTS
from scooter_broker_lib.types import Identity, Provider

from scooter_contrib_kagi import mcp_tools as kagi_tools
from scooter_contrib_kagi.broker_provider import kagi


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
        provider=Provider(name="kagi", transports=[]),
        upstream=FakeUpstream(response),
        links=FakeLinks(),
    )


def _fn(name: str):
    return getattr(kagi_tools, name)


def _data(*rows: dict) -> httpx.Response:
    return httpx.Response(200, json={"data": list(rows)})


async def test_the_related_searches_row_is_FILTERED_OUT():
    """`t: 1` is a related-searches row with a `list` and no url. Without the `t == 0`
    filter it renders as a hit the agent cannot follow. Why: PR #698."""
    ctx = _ctx(
        _data(
            {"t": 0, "title": "A real hit", "url": "https://x.test/a", "snippet": "about a"},
            {"t": 1, "list": ["related one", "related two"]},
        )
    )
    out = await _fn("kagi_web_search")(query="a", ctx=ctx)
    assert not out.is_error
    assert out.text == 'Results for "a":\n- A real hit (https://x.test/a)\n  about a'
    assert "related" not in out.text


async def test_only_result_rows_count_toward_the_cap():
    """The filter runs BEFORE the cap, so a page padded with non-result rows still
    yields a full list rather than a short one."""
    rows = []
    for i in range(MAX_RESULTS):
        rows.append({"t": 1, "list": ["noise"]})
        rows.append({"t": 0, "title": f"r{i}", "url": f"https://x.test/{i}"})
    out = await _fn("kagi_web_search")(query="q", ctx=_ctx(_data(*rows)))
    assert len([line for line in out.text.splitlines() if line.startswith("- ")]) == MAX_RESULTS


async def test_it_queries_the_documented_endpoint():
    ctx = _ctx(_data())
    await _fn("kagi_web_search")(query="some query", ctx=ctx)
    call = ctx.upstream.calls[0]
    assert (call["method"], call["path"]) == ("GET", "api/v1/search")
    assert call["params"] == {"q": "some query", "limit": MAX_RESULTS}


async def test_an_upstream_failure_is_reported_VERBATIM():
    out = await _fn("kagi_web_search")(query="q", ctx=_ctx(httpx.Response(401, text="unauthorized")))
    assert out.is_error
    assert "401" in out.text and "unauthorized" in out.text and "kagi" in out.text


# --- the provider wiring ----------------------------------------------------------

def test_the_scheme_word_is_part_of_the_value(monkeypatch):
    """Kagi wants `Authorization: Bot <token>`. kind="bearer" would send
    "Bearer <token>" and earn a 401, so the prefix travels in the value."""
    monkeypatch.setenv("KAGI_API_KEY", "secret")
    provider = kagi()
    assert provider.enabled
    assert provider.credential.kind == "header"
    assert provider.credential.header_name == "Authorization"
    assert provider.credential.token == "Bot secret"


def test_no_key_means_no_provider_and_no_bare_Bot_header(monkeypatch):
    """`"Bot "` with nothing after it is a credential-shaped empty string — the guard
    keeps the value empty so a misread `enabled` cannot send one."""
    monkeypatch.setenv("KAGI_API_KEY", "")
    provider = kagi()
    assert provider.enabled is False
    assert provider.credential.token == ""


def test_it_ships_tools_and_NO_raw_proxy_route(monkeypatch):
    monkeypatch.setenv("KAGI_API_KEY", "k")
    transports = kagi().transports
    assert [t.name for t in transports] == ["mcp-tools"]
    assert transports[0].upstream == kagi_tools.UPSTREAM


async def test_the_tool_is_named_for_its_provider_so_a_sibling_can_coexist():
    """The name is the whole reason several search providers can be enabled at once.

    Tool names are flat and global — the broker refuses to start on a duplicate
    (broker/mcp/routes.py) — so a bare `web_search` would make kagi and every
    sibling search contrib mutually exclusive. That exclusivity was an artifact of the
    name, not a real constraint; nothing stops a deployment from wanting two indexes.
    Asserted against the SERVER's registry, because that is the name the agent is shown.
    """
    names = {t.name for t in await kagi_tools.mcp.list_tools(run_middleware=False)}
    assert names == {"kagi_web_search"}
