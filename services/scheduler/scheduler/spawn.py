"""Spawn a Scooter conversation by POSTing a prompt to the agent-host /agui.

Mirrors services/webhooks/webhooks/agent_host_client.create_conversation: ask the server
for a conversation id, then POST the task as the user message. The task's `owner` rides
the BODY of both calls — honored ONLY when we present a valid SA token (the
conversation-router's and agent-host's WEBHOOKS_SERVICE_ACCOUNT list must include the
scheduler's SA). Returns the conversation_id or None on failure.
"""

from __future__ import annotations

from pathlib import Path

import httpx

from .config import settings
from .logging_config import format_error, get_logger

logger = get_logger("spawn")


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
    """Create a conversation, then prompt it. Returns the server-assigned
    conversation id, or None. `client` is injectable for tests.

    Two calls: the server mints the id (POST /conversations). We do not invent one.
    """
    base = settings.agent_host_url.rstrip("/")
    headers = {"content-type": "application/json"}
    token = _sa_token()
    if token:
        headers["authorization"] = f"Bearer {token}"

    owns = client is None
    client = client or httpx.AsyncClient(timeout=30.0)
    try:
        # 1. CREATE
        create_body: dict = {}
        if title:
            create_body["title"] = title
        if owner:
            # The owner rides the BODY, not an identity header: the header's name is
            # deployment-configurable (AUTH_USER_HEADER) and under alb-oidc is a
            # different header entirely, so a hard-coded one was silently dropped and
            # the task's conversation was created unowned (#527). Honored only for our
            # TokenReview-verified SA token.
            create_body["owner"] = owner
        resp = await client.post(f"{base}/conversations", json=create_body, headers=headers)
        if resp.status_code >= 300:
            logger.error(
                "create failed", extra={"status": resp.status_code, "task_title": title}
            )
            return None
        conversation_id = resp.json().get("id")
        if not conversation_id:
            logger.error("create returned no id", extra={"task_title": title})
            return None

        # 2. PROMPT the id the server gave us.
        body = {
            "threadId": conversation_id,
            "messages": [{"role": "user", "content": prompt}],
            # A scheduled fire is a SYSTEM message (not a human turn) — the agent-host
            # decorates it + the UI can hide it.
            "source": "scheduler",
        }
        if owner:
            body["owner"] = owner
        # /agui streams SSE; we only need the request accepted (the agent then runs
        # the turn independently).
        resp = await client.post(f"{base}/agui", json=body, headers=headers)
        if resp.status_code >= 300:
            logger.error(
                "spawn failed",
                extra={
                    "status": resp.status_code,
                    "task_title": title,
                    "conversation_id": conversation_id,
                },
            )
            return None
        return conversation_id
    except httpx.HTTPError as e:
        # str() on an httpx transport error is often EMPTY; format_error falls back to
        # repr()/the type name so this line always names the failure.
        logger.error("spawn failed", extra={"task_title": title, "error": format_error(e)})
        return None
    finally:
        if owns:
            await client.aclose()
