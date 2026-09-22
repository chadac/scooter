"""Tests for webhook handler logic.

Tests the webhook endpoint routing and handler behavior using
FastAPI's TestClient. External API calls (OpenHands, GitLab, etc.)
are mocked.
"""

from unittest.mock import AsyncMock, patch, MagicMock

import pytest
from fastapi.testclient import TestClient

from webhooks.app import app


@pytest.fixture
def client():
    """Create a test client with a mocked DB (no real store/agent-host)."""
    with patch("webhooks.app.db") as mock_db:
        mock_db.init_db = AsyncMock()
        mock_db.close_db = AsyncMock()
        with TestClient(app) as c:
            yield c


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------


def test_health_endpoint(client):
    """Health check returns ok."""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# GitLab webhook
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# GitHub webhook
# ---------------------------------------------------------------------------


def test_github_webhook_disabled(client):
    """GitHub webhook returns disabled when toggle is off."""
    with patch("webhooks.handlers.github.settings") as mock_settings:
        mock_settings.github_enabled = False
        resp = client.post(
            "/webhooks/github",
            headers={"X-Github-Event": "issue_comment", "X-Hub-Signature-256": ""},
            json={},
        )
        assert resp.json()["status"] == "disabled"


# ---------------------------------------------------------------------------
# Jira webhook
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Conversation link endpoint
# ---------------------------------------------------------------------------


def test_link_conversation_missing_header(client):
    """Link endpoint returns error when X-Conversation-ID is missing."""
    with patch("webhooks.app.require_relay_key", return_value=None):
        resp = client.post(
            "/conversations/link",
            json={
                "source": "gitlab",
                "resource_type": "merge_request",
                "resource_id": "repo!42",
            },
        )
        data = resp.json()
        assert data["linked"] is False
        assert "No X-Conversation-ID" in data["error"]
