"""Unit test for the whoami transport + registry, with a MOCKED token.

Proves: the test provider mounts /test/whoami, the route runs the auth
dependency, records the call, and returns the validated Identity. Real
TokenReview/IRSA is exercised in the cluster e2e; here auth is overridden with a
fake identity (per the decision: mocked token for unit tests).
"""

from __future__ import annotations

import os

os.environ["TEST_PROVIDER_ENABLED"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

from broker.core.app import create_app  # noqa: E402
from broker.core.auth import authenticate  # noqa: E402
from broker.core.types import Identity  # noqa: E402
from broker.providers.echo import recorder  # noqa: E402


def _fake_identity() -> Identity:
    return Identity(
        conversation_id="conv-abc123",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:sandbox-conv-abc123",
    )


def _client() -> TestClient:
    app = create_app()
    app.dependency_overrides[authenticate] = _fake_identity
    return TestClient(app)


def test_whoami_returns_validated_identity():
    recorder.calls.clear()
    client = _client()

    resp = client.get("/test/whoami")

    assert resp.status_code == 200
    body = resp.json()
    assert body["conversation_id"] == "conv-abc123"
    assert body["namespace"] == "agent-sandbox"
    assert body["service_account"].endswith("sandbox-conv-abc123")


def test_whoami_records_the_call():
    recorder.calls.clear()
    client = _client()

    client.get("/test/whoami")

    assert len(recorder.calls) == 1
    assert recorder.calls[0].conversation_id == "conv-abc123"


def test_test_provider_mounts_whoami():
    app = create_app()
    paths = {r.path for r in app.routes}  # type: ignore[attr-defined]
    assert "/test/whoami" in paths
