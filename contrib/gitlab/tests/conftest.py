"""Shared fixtures for the gitlab contrib's tests."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def no_approval_gate(monkeypatch):
    """Delivery suites run ungated; test_outsider_gate.py re-enables it."""
    from scooter_contrib_gitlab.config import settings

    monkeypatch.setattr(settings, "gitlab_require_approval", False)
