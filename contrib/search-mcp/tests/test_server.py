"""Tests for the shared search MCP server.

NOT YET COLLECTED BY CI — `contrib/search-mcp/` is intentionally not a contrib (it
has no default.nix), so the per-contrib pytest that runs contrib/<name>/tests never
sees these. The right long-term home is a nixosTest alongside
nixos-tests/mcp-servers.nix, which would cover the systemd unit and the mcp-proxy
bridge as well. Until then, run them directly:

    python3 -m pytest contrib/search-mcp/tests/test_server.py
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

SERVER_PY = Path(__file__).resolve().parent.parent / "server.py"


def load(monkeypatch, provider: str, tool: str):
    """Import server.py fresh with the given provider env.

    Re-imported per test because the module reads its provider and tool name from
    env at import time — in production it is a one-shot process, never reconfigured.
    """
    monkeypatch.setenv("SEARCH_PROVIDER", provider)
    monkeypatch.setenv("SEARCH_TOOL_NAME", tool)
    spec = importlib.util.spec_from_file_location(f"searchsrv_{provider}", SERVER_PY)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def brave(monkeypatch):
    return load(monkeypatch, "brave", "brave_search")


@pytest.fixture
def kagi(monkeypatch):
    return load(monkeypatch, "kagi", "kagi_search")


def test_initialize_and_tools_list(brave):
    init = brave.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    assert init["result"]["capabilities"] == {"tools": {}}

    listed = brave.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    tools = listed["result"]["tools"]
    assert [t["name"] for t in tools] == ["brave_search"]
    assert tools[0]["inputSchema"]["required"] == ["query"]


def test_a_notification_gets_no_reply(brave):
    # Answering a notification is a protocol error, not a harmless extra.
    assert brave.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None


def test_unknown_method_is_a_jsonrpc_error(brave):
    out = brave.handle({"jsonrpc": "2.0", "id": 9, "method": "nope"})
    assert out["error"]["code"] == -32601


def test_empty_query_is_rejected_before_any_call(brave, monkeypatch):
    called = False

    def never(_path):
        nonlocal called
        called = True
        return 200, "{}"

    monkeypatch.setattr(brave, "_broker_get", never)
    out = brave.handle(
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "brave_search", "arguments": {"query": "   "}},
        }
    )
    assert out["error"]["code"] == -32602
    assert not called, "a blank query must not reach the broker — it would bill a request"


def test_wrong_tool_name_is_rejected(brave):
    out = brave.handle(
        {
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {"name": "kagi_search", "arguments": {"query": "q"}},
        }
    )
    assert out["error"]["code"] == -32602


def test_brave_results_render_with_urls(brave, monkeypatch):
    doc = {
        "web": {
            "results": [
                {"title": "T", "url": "https://a.test", "description": "S"},
                {"url": "https://no-title.test"},
            ]
        }
    }
    monkeypatch.setattr(brave, "_broker_get", lambda _p: (200, json.dumps(doc)))
    text, is_error = brave.run_search("q")
    assert not is_error
    assert "https://a.test" in text and "S" in text
    # A row with no title still has to be usable — the url stands in for it.
    assert "https://no-title.test" in text


def test_kagi_drops_the_related_searches_row(kagi, monkeypatch):
    # t == 1 carries a `list` and no url; without the t == 0 filter it renders as a
    # bogus hit.
    doc = {
        "data": [
            {"t": 0, "title": "Result", "url": "https://a.test", "snippet": "snip"},
            {"t": 1, "list": ["related one"]},
        ]
    }
    monkeypatch.setattr(kagi, "_broker_get", lambda _p: (200, json.dumps(doc)))
    text, is_error = kagi.run_search("q")
    assert not is_error
    assert "https://a.test" in text
    assert "related one" not in text


def test_empty_results_are_not_an_error(brave, monkeypatch):
    monkeypatch.setattr(
        brave, "_broker_get", lambda _p: (200, json.dumps({"web": {"results": []}}))
    )
    text, is_error = brave.run_search("zzz")
    assert not is_error
    assert "No results" in text


def test_broker_404_is_echoed_verbatim_as_an_error(brave, monkeypatch):
    # The broker 404s /<provider>/* when that provider is not configured. That must
    # read as a failure naming the status, never as an empty web — the whole point
    # of replacing the old DuckDuckGo path.
    monkeypatch.setattr(brave, "_broker_get", lambda _p: (404, '{"detail":"Not Found"}'))
    text, is_error = brave.run_search("q")
    assert is_error
    assert "404" in text and "Not Found" in text


def test_transport_failure_is_an_error(brave, monkeypatch):
    monkeypatch.setattr(brave, "_broker_get", lambda _p: (0, "could not reach the broker: boom"))
    text, is_error = brave.run_search("q")
    assert is_error
    assert "boom" in text


def test_unparseable_body_is_an_error_not_an_empty_result(brave, monkeypatch):
    monkeypatch.setattr(brave, "_broker_get", lambda _p: (200, "<html>nope</html>"))
    text, is_error = brave.run_search("q")
    assert is_error
    assert "could not parse" in text


def test_unknown_provider_is_an_error(monkeypatch):
    mod = load(monkeypatch, "bing", "bing_search")
    text, is_error = mod.run_search("q")
    assert is_error
    assert "unknown SEARCH_PROVIDER" in text


def test_no_broker_url_names_the_cause(brave, monkeypatch):
    monkeypatch.delenv("BROKER_URL", raising=False)
    status, body = brave._broker_get("brave/res/v1/web/search?q=x")
    assert status == 0
    assert "BROKER_URL is not set" in body
