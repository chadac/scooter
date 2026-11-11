"""A slow TokenReview must not stall the event loop, or /health stops answering."""

from __future__ import annotations

import asyncio
import time

import httpx
import pytest
from fastapi import Depends

from broker.core import auth as auth_mod
from broker.core.app import create_app

SANDBOX_SA = "system:serviceaccount:agent-sandbox:sandbox-abc"


class _User:
    def __init__(self, username): self.username = username


class _Status:
    def __init__(self, username): self.authenticated, self.user = True, _User(username)


class _Result:
    def __init__(self, username): self.status = _Status(username)


class _SlowApi:
    """The sync kubernetes client against an apiserver mid-restart: a blocking read."""

    def __init__(self, delay: float):
        self.delay = delay
        self.kwargs: dict | None = None

    def create_token_review(self, _review, **kwargs):
        self.kwargs = kwargs
        time.sleep(self.delay)
        return _Result(SANDBOX_SA)


@pytest.fixture
def slow_api(monkeypatch):
    api = _SlowApi(delay=1.5)
    monkeypatch.setattr(auth_mod, "_api", lambda: api)
    monkeypatch.setattr(auth_mod.settings, "sandbox_namespace", "agent-sandbox")
    return api


async def test_health_answers_while_a_token_review_is_slow(slow_api):
    app = create_app()

    @app.get("/_authenticated")
    async def _authenticated(identity=Depends(auth_mod.authenticate)):
        return {"conversation": identity.conversation_id}

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://broker") as c:
        t0 = time.monotonic()
        slow = asyncio.create_task(c.get("/_authenticated", headers={"authorization": "Bearer t"}))
        await asyncio.sleep(0.1)
        health = await c.get("/health")
        health_latency = time.monotonic() - t0
        reviewed = await slow

    assert reviewed.status_code == 200
    assert health.status_code == 200
    # Kubelet's liveness probe times out after 1s.
    assert health_latency < 0.5, f"/health waited {health_latency:.2f}s behind a TokenReview"


async def test_token_review_passes_a_request_timeout(slow_api):
    slow_api.delay = 0
    await auth_mod._review("timeout-probe")
    assert slow_api.kwargs == {"_request_timeout": auth_mod.settings.token_review_timeout_s}
