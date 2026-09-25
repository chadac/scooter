"""Auto-linking MECHANISM: the transport posts a link on a 2xx create.

Which calls a given provider auto-links is that provider's knowledge and lives in
its contrib (gitlab PR #580, github PR #XXX); what stays here is the transport
behaviour, driven by a stand-in rule rather than any provider's real ones.
"""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.autolink import Link, rule
from scooter_broker_lib.transports.http_proxy import HttpProxy


_CREATE_RULES = [
    rule(
        "POST", r"^repos/[^/]+/[^/]+/pulls/?$",
        lambda r: Link(source="test", resource_type="pr", url=r.get("html_url", ""), title=r.get("title")),
    ),
]


# ---- the transport posts a link on a 2xx create, and NOT otherwise ----


@pytest.mark.asyncio
async def test_maybe_autolink_posts_on_match(monkeypatch):
    posted: list = []

    async def fake_post_link(agent_host_url, conversation_id, link):
        posted.append((agent_host_url, conversation_id, link))

    import scooter_broker_lib.transports.http_proxy as hp
    monkeypatch.setattr(hp, "post_link", fake_post_link)

    proxy = HttpProxy(
        upstream="https://api.example.com",
        link_rules=_CREATE_RULES,
        agent_host_url="http://agent-host:8080",
    )
    resp = httpx.Response(201, json={"html_url": "https://example.com/a/b/pull/1", "title": "T"})
    await proxy._maybe_autolink("POST", "repos/a/b/pulls", resp, "conv-1")

    assert len(posted) == 1
    _, conv, link = posted[0]
    assert conv == "conv-1"
    assert link.url == "https://example.com/a/b/pull/1"


@pytest.mark.asyncio
async def test_maybe_autolink_ignores_non_matching_path(monkeypatch):
    posted: list = []
    import scooter_broker_lib.transports.http_proxy as hp
    monkeypatch.setattr(hp, "post_link", lambda *a: posted.append(a))
    proxy = HttpProxy(upstream="x", link_rules=_CREATE_RULES, agent_host_url="http://h")
    # A comment POST — not a create rule.
    resp = httpx.Response(201, json={"html_url": "https://example.com/a/b/issues/1#c"})
    await proxy._maybe_autolink("POST", "repos/a/b/issues/1/comments", resp, "conv-1")
    assert posted == []


@pytest.mark.asyncio
async def test_maybe_autolink_swallows_bad_response(monkeypatch):
    # A non-JSON / unexpected body must not raise (best-effort).
    import scooter_broker_lib.transports.http_proxy as hp
    monkeypatch.setattr(hp, "post_link", lambda *a: None)
    proxy = HttpProxy(upstream="x", link_rules=_CREATE_RULES, agent_host_url="http://h")
    resp = httpx.Response(201, content=b"not json")
    await proxy._maybe_autolink("POST", "repos/a/b/pulls", resp, "conv-1")  # must not raise
