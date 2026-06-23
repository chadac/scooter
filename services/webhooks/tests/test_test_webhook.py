"""Unit tests for the /webhooks/test endpoint (the e2e spawn harness)."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

import webhooks.app
from webhooks.config import settings


@pytest.fixture
def client():
    # Enable the test webhook on the live settings object (order-independent).
    with patch.object(settings, "test_webhook_enabled", True), patch("webhooks.app.db") as mock_db:
        mock_db.init_db = AsyncMock()
        mock_db.close_db = AsyncMock()
        with TestClient(webhooks.app.app) as c:
            yield c


def test_test_webhook_spawns_and_returns_id(client):
    with patch(
        "webhooks.handlers.test.create_conversation",
        AsyncMock(return_value={"conversation_id": "abc", "result": "did the thing"}),
    ) as spawn:
        resp = client.post("/webhooks/test", json={"task": "do a thing", "title": "T"})

    assert resp.status_code == 200
    body = resp.json()
    assert body["conversation_id"] == "abc"
    assert body["result"] == "did the thing"
    spawn.assert_awaited_once()
    assert spawn.await_args is not None
    assert spawn.await_args.args[0] == "do a thing"


def test_test_webhook_502_on_spawn_failure(client):
    with patch(
        "webhooks.handlers.test.create_conversation",
        AsyncMock(return_value=None),
    ):
        resp = client.post("/webhooks/test", json={"task": "x"})
    assert resp.status_code == 502


def test_test_webhook_404_when_disabled():
    with patch.object(settings, "test_webhook_enabled", False), patch("webhooks.app.db") as mock_db:
        mock_db.init_db = AsyncMock()
        mock_db.close_db = AsyncMock()
        with TestClient(webhooks.app.app) as c:
            resp = c.post("/webhooks/test", json={"task": "x"})
    assert resp.status_code == 404
