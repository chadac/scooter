"""Datadog provider — two-key header auth + http-proxy target + enable gating.

Datadog needs TWO headers (DD-API-KEY + DD-APPLICATION-KEY) on every request.
Proves: the source emits a multi-header credential that injects BOTH onto the
outbound request; the provider proxies to the configured site and is enabled only
when both keys are present.

These drive the provider through the ENVIRONMENT rather than by patching a
settings singleton, which is what the broker app's copy of this file did. That is
the point of the move: the contrib reads DATADOG_* itself, so the test now covers
the real configuration path end to end — including that the variable names are
the ones a deployment already sets. Why: PR #573.
"""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Identity
from scooter_contrib_datadog.broker_provider import datadog
from scooter_contrib_datadog.datadog_keys import DatadogKeysSource


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ("DATADOG_API_KEY", "DATADOG_APP_KEY", "DATADOG_SITE"):
        monkeypatch.delenv(var, raising=False)


@pytest.mark.asyncio
async def test_datadog_source_injects_both_keys():
    src = DatadogKeysSource(api_key="dd-api", app_key="dd-app")
    cred = await src.get(_identity())
    req = httpx.Request("GET", "https://api.datadoghq.com/api/v1/validate")
    cred.inject(req)
    assert req.headers["DD-API-KEY"] == "dd-api"
    assert req.headers["DD-APPLICATION-KEY"] == "dd-app"


def test_provider_proxies_to_configured_site(monkeypatch):
    monkeypatch.setenv("DATADOG_API_KEY", "k")
    monkeypatch.setenv("DATADOG_APP_KEY", "a")
    monkeypatch.setenv("DATADOG_SITE", "datadoghq.eu")

    provider = datadog()
    assert provider.name == "datadog"
    proxy = next(t for t in provider.transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.datadoghq.eu"


def test_site_defaults_to_us(monkeypatch):
    monkeypatch.setenv("DATADOG_API_KEY", "k")
    monkeypatch.setenv("DATADOG_APP_KEY", "a")

    proxy = next(t for t in datadog().transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.datadoghq.com"


@pytest.mark.parametrize("site", [" datadoghq.eu ", ".datadoghq.eu"])
def test_site_is_normalised(monkeypatch, site):
    # A stray leading dot or whitespace in a manifest must not produce
    # https://api..datadoghq.eu — the request would fail with a DNS error that
    # says nothing about the config that caused it.
    monkeypatch.setenv("DATADOG_API_KEY", "k")
    monkeypatch.setenv("DATADOG_APP_KEY", "a")
    monkeypatch.setenv("DATADOG_SITE", site)

    proxy = next(t for t in datadog().transports if isinstance(t, HttpProxy))
    assert proxy.upstream == "https://api.datadoghq.eu"


def test_provider_disabled_without_both_keys(monkeypatch):
    # Only the API key -> still disabled (the app key is required too).
    monkeypatch.setenv("DATADOG_API_KEY", "k")
    assert datadog().enabled is False

    # Neither key -> disabled.
    monkeypatch.delenv("DATADOG_API_KEY")
    assert datadog().enabled is False

    # Both keys -> enabled.
    monkeypatch.setenv("DATADOG_API_KEY", "k")
    monkeypatch.setenv("DATADOG_APP_KEY", "a")
    assert datadog().enabled is True


def test_reads_the_env_vars_the_manifests_already_inject(monkeypatch):
    # modules/broker.nix injects DATADOG_API_KEY / DATADOG_APP_KEY from secrets.
    # If this contrib read anything else, a deployed broker would silently lose
    # its datadog provider on upgrade — with no error, just a missing route.
    monkeypatch.setenv("DATADOG_API_KEY", "from-secret")
    monkeypatch.setenv("DATADOG_APP_KEY", "also-from-secret")

    provider = datadog()
    assert provider.enabled is True
    assert provider.credential.api_key == "from-secret"
    assert provider.credential.app_key == "also-from-secret"
