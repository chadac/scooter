"""Spawn a Scooter conversation by POSTing a prompt to the agent-host /agui.

Mirrors services/webhooks/webhooks/agent_host_client.create_conversation: generate a
threadId, POST the task as the user message, and ride the `owner` on the body — which
the agent-host honors ONLY when we present a valid SA token (its WEBHOOKS_SERVICE_ACCOUNT
list must include the scheduler's SA). Returns the conversation_id or None on failure.
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

import httpx

from .config import settings

logger = logging.getLogger("scheduler.spawn")


def _sa_token() -> str | None:
    """Read the projected SA token the agent-host verifies (owner trust chain).
    Missing/unreadable → None (owner won't be honored, but the run still spawns)."""
    try:
        return Path(settings.sa_token_path).read_text().strip() or None
    except OSError:
        return None


async def spawn_conversation(
    prompt: str, *, title: str | None, owner: str | None, client: httpx.AsyncClient | None = None
) -> str | None:
    """POST the prompt to the agent-host /agui. Returns the conversation_id
    (the threadId we generate) on a 2xx, else None. `client` is injectable for tests."""
    conversation_id = str(uuid.uuid4())
    body: dict = {
        "threadId": conversation_id,
        "messages": [{"role": "user", "content": prompt}],
    }
    if title:
        body["title"] = title
    if owner:
        # Honored only for the SA-token-verified caller (webhooksCaller); the
        # scheduler's SA must be in the agent-host's trusted list.
        body["owner"] = owner

    headers = {"content-type": "application/json"}
    token = _sa_token()
    if token:
        headers["authorization"] = f"Bearer {token}"

    url = f"{settings.agent_host_url.rstrip('/')}/agui"
    owns = client is None
    client = client or httpx.AsyncClient(timeout=30.0)
    try:
        # /agui streams SSE; we only need the request accepted (the agent then runs
        # the turn independently). Read+discard the stream quickly, or just POST.
        resp = await client.post(url, json=body, headers=headers)
        if resp.status_code >= 300:
            logger.error("spawn failed: HTTP %s for task %r", resp.status_code, title)
            return None
        return conversation_id
    except httpx.HTTPError as e:
        logger.error("spawn failed: %s", e)
        return None
    finally:
        if owns:
            await client.aclose()
