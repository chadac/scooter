"""Agent-host client — spawn + drive agent conversations from webhooks.

Replaces the OpenHands-coupled client. We spawn a conversation by POSTing the
task to the agent-host's standard AG-UI endpoint (POST /agui) — the same path
the UI uses — and read the SSE event stream to know when the run finishes and to
collect the final assistant message.

The conversation_id IS the threadId we generate, so it's known up front (the
thread<->conversation mapping can be recorded immediately).
"""

from __future__ import annotations

import json
import logging
import uuid

import httpx

from .config import settings

logger = logging.getLogger(__name__)


def _agui_url() -> str:
    return f"{settings.agent_host_url.rstrip('/')}/agui"


async def create_conversation(
    initial_message: str,
    repository: str | None = None,
    git_provider: str = "github",
    title: str | None = None,
) -> dict | None:
    """Spawn an agent conversation for `initial_message`.

    Generates a threadId, POSTs the task to the agent-host /agui endpoint, and
    consumes the AG-UI SSE stream until RUN_FINISHED, accumulating the final
    assistant message. Returns {conversation_id, result} or None on failure.

    `repository` is woven into the task text (the agent works in its sandbox).
    """
    conversation_id = str(uuid.uuid4())
    task = initial_message
    if repository:
        task = f"Repository: {repository}\n\n{task}"

    payload = {
        "threadId": conversation_id,
        "runId": str(uuid.uuid4()),
        "messages": [{"role": "user", "content": task}],
    }

    try:
        result_text = await _run_and_collect(payload)
    except Exception:
        logger.exception("create_conversation failed")
        return None

    return {"conversation_id": conversation_id, "result": result_text}


async def send_message(conversation_id: str, message: str) -> bool:
    """Send a follow-up message into an existing conversation (same thread)."""
    payload = {
        "threadId": conversation_id,
        "runId": str(uuid.uuid4()),
        "messages": [{"role": "user", "content": message}],
    }
    try:
        await _run_and_collect(payload)
        return True
    except Exception:
        logger.exception("send_message failed for %s", conversation_id)
        return False


async def _run_and_collect(payload: dict) -> str:
    """POST a RunAgentInput to /agui and accumulate the final assistant text from
    the AG-UI SSE stream (TEXT_MESSAGE_CONTENT deltas), returning on RUN_FINISHED.
    """
    text_parts: list[str] = []
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream(
            "POST", _agui_url(), json=payload, headers={"Accept": "text/event-stream"}
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[len("data:"):].strip())
                except json.JSONDecodeError:
                    continue
                etype = event.get("type")
                if etype == "TEXT_MESSAGE_CONTENT":
                    text_parts.append(event.get("delta", ""))
                elif etype == "RUN_FINISHED":
                    break
                elif etype == "RUN_ERROR":
                    raise RuntimeError(event.get("message", "agent run error"))
    return "".join(text_parts).strip()


async def push_link(
    conversation_id: str,
    *,
    source: str,
    resource_type: str,
    url: str | None = None,
    title: str | None = None,
) -> bool:
    """Record an external resource link (the PR/issue/thread this conversation
    came from) on the agent-host, so the UI's linked-resources panel can show it.
    Best-effort — a failure must not break the webhook flow."""
    base = settings.agent_host_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{base}/conversations/{conversation_id}/links",
                json={"source": source, "resourceType": resource_type, "url": url, "title": title},
            )
            return resp.status_code in (200, 201)
    except httpx.HTTPError:
        logger.warning("push_link failed for %s (%s/%s)", conversation_id, source, resource_type)
        return False


async def get_conversation_status(conversation_id: str) -> str | None:
    """Status of a conversation via the agent-host management API."""
    base = settings.agent_host_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base}/conversations/{conversation_id}")
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return resp.json().get("status")
    except httpx.HTTPError:
        logger.warning("status fetch failed for %s", conversation_id)
        return None


async def get_conversation_statuses(conversation_ids: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for cid in conversation_ids:
        status = await get_conversation_status(cid)
        if status:
            out[cid] = status
    return out


async def resolve_sandbox_to_conversation(sandbox_or_conv_id: str) -> str | None:
    """conversation_id == threadId, so it resolves to itself."""
    return sandbox_or_conv_id


def conversation_url(conversation_id: str) -> str:
    base = settings.agent_manager_url.rstrip("/")
    return f"{base}/?thread={conversation_id}" if base else conversation_id
