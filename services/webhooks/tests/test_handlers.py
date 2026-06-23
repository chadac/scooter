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


def test_gitlab_webhook_disabled(client):
    """GitLab webhook returns disabled when toggle is off."""
    with patch("webhooks.handlers.gitlab.settings") as mock_settings:
        mock_settings.gitlab_enabled = False
        resp = client.post(
            "/webhooks/gitlab",
            headers={"X-Gitlab-Event": "Note Hook", "X-Gitlab-Token": ""},
            json={},
        )
        assert resp.json()["status"] == "disabled"


def test_gitlab_webhook_invalid_token(client):
    """GitLab webhook rejects invalid token."""
    with patch("webhooks.handlers.gitlab.settings") as mock_settings:
        mock_settings.gitlab_enabled = True
        mock_settings.gitlab_webhook_secret = "real-secret"
        resp = client.post(
            "/webhooks/gitlab",
            headers={"X-Gitlab-Event": "Note Hook", "X-Gitlab-Token": "wrong"},
            json={},
        )
        assert resp.status_code == 401


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


def test_jira_webhook_disabled(client):
    """Jira webhook returns disabled when toggle is off."""
    with patch("webhooks.handlers.jira.settings") as mock_settings:
        mock_settings.jira_enabled = False
        resp = client.post("/webhooks/jira", json={})
        assert resp.json()["status"] == "disabled"


# ---------------------------------------------------------------------------
# Slack webhook
# ---------------------------------------------------------------------------


def test_slack_webhook_disabled(client):
    """Slack webhook returns disabled when toggle is off."""
    with patch("webhooks.handlers.slack.settings") as mock_settings:
        mock_settings.slack_enabled = False
        resp = client.post("/webhooks/slack", json={})
        assert resp.json()["status"] == "disabled"


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
