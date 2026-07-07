"""Datadog provider — two-key header auth + http-proxy target + enable gating.

Datadog needs TWO headers (DD-API-KEY + DD-APPLICATION-KEY) on every request.
Proves: the source emits a multi-header credential that injects BOTH onto the
outbound request; the provider proxies to the configured site and is enabled only
when both keys are present.
"""

from __future__ import annotations

import httpx
import pytest

from broker.core.types import Identity
from broker.sources.datadog_keys import DatadogKeysSource
from broker.transports.http_proxy import HttpProxy


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.mark.asyncio
async def test_datadog_source_injects_both_keys():
    src = DatadogKeysSource(api_key="dd-api", app_key="dd-app")
    cred = await src.get(_identity())
    assert cred.kind == "multi-header"

    req = httpx.Request("GET", "https://api.datadoghq.com/api/v1/query")
    cred.inject(req)
    assert req.headers["DD-API-KEY"] == "dd-api"
    assert req.headers["DD-APPLICATION-KEY"] == "dd-app"


def test_provider_proxies_to_configured_site(monkeypatch):
    # The upstream host is region-specific via config.datadog_site.
    from broker import config as cfg

    monkeypatch.setattr(cfg.settings, "datadog_api_key", "k", raising=False)
    monkeypatch.setattr(cfg.settings, "datadog_app_key", "a", raising=False)
    monkeypatch.setattr(cfg.settings, "datadog_site", "datadoghq.eu", raising=False)

    from broker.providers.datadog import datadog

    provider = datadog()
    assert provider.name == "datadog"
    proxy = next(t for t in provider.transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.datadoghq.eu"


def test_provider_disabled_without_both_keys(monkeypatch):
    from broker import config as cfg
    from broker.providers.datadog import datadog

    # Only the API key -> still disabled (the app key is required too).
    monkeypatch.setattr(cfg.settings, "datadog_api_key", "k", raising=False)
    monkeypatch.setattr(cfg.settings, "datadog_app_key", "", raising=False)
    assert datadog().enabled is False

    # Neither key -> disabled.
    monkeypatch.setattr(cfg.settings, "datadog_api_key", "", raising=False)
    assert datadog().enabled is False

    # Both keys -> enabled.
    monkeypatch.setattr(cfg.settings, "datadog_api_key", "k", raising=False)
    monkeypatch.setattr(cfg.settings, "datadog_app_key", "a", raising=False)
    assert datadog().enabled is True
