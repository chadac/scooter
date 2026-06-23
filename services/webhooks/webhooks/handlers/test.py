"""Test webhook handler — a gated endpoint for end-to-end webhook tests.

POST /webhooks/test {"task": "...", "title?": "..."} spawns a real conversation
in the agent-host (no signature, no provider creds), and returns the
conversation id. Lets a cluster e2e prove the full webhook -> spawn -> /agui ->
result loop without real GitHub/Slack. Enabled only when test_webhook_enabled.

Mirrors the broker's `test` (whoami) provider.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..agent_host_client import create_conversation
from ..config import settings

logger = logging.getLogger(__name__)

router = APIRouter()


class TestEvent(BaseModel):
    task: str
    title: str | None = None


@router.post("/webhooks/test")
async def test_webhook(event: TestEvent) -> dict:
    if not settings.test_webhook_enabled:
        raise HTTPException(status_code=404, detail="test webhook disabled")

    result = await create_conversation(event.task, title=event.title)
    if result is None:
        raise HTTPException(status_code=502, detail="spawn failed")

    return {
        "conversation_id": result["conversation_id"],
        "result": result.get("result", ""),
    }
