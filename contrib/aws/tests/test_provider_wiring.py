"""The provider must use the authorizer it is handed, not one it made itself."""

from __future__ import annotations

import json

import pytest

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.store import StoreConfig


class _Sentinel:
    """Stands in for the app-built authorizer."""

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
            "approval_rules": [
                {"name": "grants", "anchor": True},
                {"name": "sg/secrets", "effect": "require_always", "actions": ["secretsmanager:GetSecretValue"],
                 "resources": ["*"], "managed_policy_arns": [], "approvers": ["sec@example.com"]},
            ],
        }
    }))
    monkeypatch.setenv("AWS_ENABLED", "true")
    monkeypatch.setenv("AWS_ACCOUNTS_FILE", str(accounts))
    # The module-level settings were read at import, before these env vars existed.
    import scooter_contrib_aws.config as cfg
    import scooter_contrib_aws.broker_provider as bp
    fresh = cfg.AwsSettings()
    monkeypatch.setattr(cfg, "settings", fresh)
    monkeypatch.setattr(bp, "settings", fresh)
    return tmp_path


def _context(tmp_path, authorizer):
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
    """The provider must carry its permissions and grants transports."""
    import scooter_contrib_aws.broker_provider as aws_provider

    provider = aws_provider.aws(_context(_aws_env, _Sentinel()))
    assert [t.name for t in provider.transports] == ["aws-permissions", "grants"]


async def test_startup_seeds_account_and_rule_approvers(_aws_env):
    import scooter_contrib_aws.broker_provider as aws_provider

    class _Recording(_Sentinel):
        def __init__(self):
            self.granted = []

        async def grant(self, *, user: str, relation: str, obj: str) -> None:
            self.granted.append((user, obj))

    authz = _Recording()
    provider = aws_provider.aws(_context(_aws_env, authz))
    await provider.on_startup()
    await provider.on_shutdown()
    assert authz.granted == [
        ("user:alice@example.com", "aws_account:dev"),
        ("user:sec@example.com", "aws_account:dev/sg/secrets"),
    ]
