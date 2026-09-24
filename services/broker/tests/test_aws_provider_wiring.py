"""aws must actually build THROUGH the app, with the app's authorizer.

aws is the first provider whose factory declares a BrokerContext parameter. If the
app ever stops passing one, the registry refuses to build the provider — correct, but
the symptom is aws simply ABSENT: its routes 404/503, which reads like "disabled" in
a deployment that very much meant to enable it. Nothing in the suite built aws through
create_app() before, so that wiring was untested in both directions.

The second assertion is the one with teeth: the authorizer reaching PermissionService
must be the object the APP built, not one the factory made for itself — a provider
that can construct its own can construct a NoopAuthorizer and allow every approval.
"""

from __future__ import annotations

import json

import pytest

from broker.core.app import create_app


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
    # SQLite, so building the store opens nothing real.
    monkeypatch.setenv("AWS_DB_DSN", f"sqlite+aiosqlite:///{tmp_path / 'aws.db'}")
    monkeypatch.delenv("AWS_DB_PASSWORD", raising=False)


def test_aws_routes_are_mounted(_aws_env):
    """If the app stopped supplying a context the provider would be skipped, and
    these paths would be gone — the "absent, not disabled" failure.

    Asserted through the OpenAPI schema, not `app.routes`: this FastAPI keeps an
    included router as an opaque `_IncludedRouter` in that list rather than
    flattening it into APIRoutes, so scanning it for `.path` silently sees no
    provider routes at all — for a mounted provider and an absent one alike.
    """
    app = create_app()
    paths = app.openapi()["paths"]
    assert any(p.startswith("/aws/") for p in paths), f"mounted paths: {sorted(paths)}"


def test_service_gets_the_authorizer_the_app_built(_aws_env, monkeypatch):
    captured: dict = {}
    sentinel = _Sentinel()

    # Patched where create_app LOOKS it up: it does `from .authz import
    # authorizer_from_settings` at import, so rebinding the core.authz original
    # would leave the already-bound name in core.app untouched.
    monkeypatch.setattr(
        "broker.core.app.authorizer_from_settings", lambda _s: sentinel
    )

    import broker.providers.aws as aws_provider

    real_service = aws_provider.PermissionService

    def _capture(**kwargs):
        captured.update(kwargs)
        return real_service(**kwargs)

    monkeypatch.setattr(aws_provider, "PermissionService", _capture)

    create_app()
    assert captured, "the aws factory never built a PermissionService"
    assert captured["authorizer"] is sentinel
