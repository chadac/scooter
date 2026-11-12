"""Jira's broker half: the tools' provider, gated on the shared Atlassian client."""

from __future__ import annotations

from scooter_broker_lib.transports.mcp_tools import McpTools
from scooter_contrib_jira.atlassian_oauth import AtlassianOAuthSource
from scooter_contrib_jira.broker_provider import jira


def test_tools_call_the_cloud_api_with_the_shared_client(monkeypatch):
    monkeypatch.setenv("ATLASSIAN_CLIENT_ID", "cid")
    monkeypatch.setenv("ATLASSIAN_CLIENT_SECRET", "sec")
    monkeypatch.setenv("ATLASSIAN_CLOUD_ID", "c1")
    p = jira()
    assert p.enabled
    (t,) = p.transports
    assert isinstance(t, McpTools) and t.upstream == "https://api.atlassian.com/ex/jira/c1"
    assert isinstance(p.credential, AtlassianOAuthSource)
    assert (p.credential.client_id, p.credential.client_secret) == ("cid", "sec")


def test_disabled_without_a_cloud_id(monkeypatch):
    monkeypatch.setenv("ATLASSIAN_CLIENT_ID", "cid")
    monkeypatch.delenv("ATLASSIAN_CLOUD_ID", raising=False)
    assert not jira().enabled
