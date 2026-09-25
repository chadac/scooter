"""The provider must USE the authorizer it is handed, not one it made itself.

This is the consumer half of the BrokerContext contract (PR #624). The app builds
one authorizer and passes it in; if this factory ever constructed its own it could
construct a NoopAuthorizer — which allows everything — and the deployment would look
identical to a working one while enforcing nothing on approve/deny.

The other half, "the app actually passes a context to a factory that asks for one",
is the APP's guarantee and is tested there
(services/broker/tests/test_provider_context_wiring.py), without naming aws. It used
to live here as a create_app() test; a contrib suite importing the broker app is
exactly the coupling this migration removes. Why: PR #599.
"""

from __future__ import annotations

import json

import pytest

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.store import StoreConfig


class _Sentinel:
    """Stands in for the app-built authorizer; identity is the whole assertion."""

    async def check(self, *, user: str, relation: str, obj: str) -> bool:
        return True

    async def grant(self, *, user: str, relation: str, obj: str) -> None:
        return None


@pytest.fixture
def _aws_env(monkeypatch, tmp_path):
    accounts = tmp_path / "accounts.json"
    accounts.write_text(json.dumps({
        "dev": {
            "account_id": "123456789012",
            "broker_role_arn": "arn:aws:iam::123456789012:role/base",
            "enabled": True,
            "approvers": ["alice@example.com"],
        }
    }))
    monkeypatch.setenv("AWS_ENABLED", "true")
    monkeypatch.setenv("AWS_ACCOUNTS_FILE", str(accounts))
    # The module-level snapshot was taken at import, before these env vars existed.
    import scooter_contrib_aws.config as cfg
    import scooter_contrib_aws.broker_provider as bp
    fresh = cfg.AwsSettings()
    monkeypatch.setattr(cfg, "settings", fresh)
    monkeypatch.setattr(bp, "settings", fresh)
    return tmp_path


def _context(tmp_path, authorizer):
    # SQLite, so building the store opens nothing real.
    return BrokerContext(
        authorizer=authorizer,
        store_config=StoreConfig(dsn=f"sqlite+aiosqlite:///{tmp_path / 'aws.db'}"),
    )


def test_service_gets_the_authorizer_it_was_given(_aws_env, monkeypatch):
    import scooter_contrib_aws.broker_provider as aws_provider

    captured: dict = {}
    real_service = aws_provider.PermissionService

    def _capture(**kwargs):
        captured.update(kwargs)
        return real_service(**kwargs)

    monkeypatch.setattr(aws_provider, "PermissionService", _capture)

    sentinel = _Sentinel()
    provider = aws_provider.aws(_context(_aws_env, sentinel))

    assert captured, "the factory never built a PermissionService"
    assert captured["authorizer"] is sentinel
    assert provider.enabled, "aws_enabled + a registry should enable the provider"


def test_the_transport_is_mounted_on_the_provider(_aws_env):
    """The provider must carry its permissions transport; without it /aws/* 404s in
    a deployment that enabled aws — the "absent, not disabled" failure."""
    import scooter_contrib_aws.broker_provider as aws_provider

    provider = aws_provider.aws(_context(_aws_env, _Sentinel()))
    assert [t.name for t in provider.transports] == ["aws-permissions"]
