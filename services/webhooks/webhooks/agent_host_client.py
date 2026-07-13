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
from collections.abc import Awaitable, Callable

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
    on_created: Callable[[str], Awaitable[None]] | None = None,
    owner: str | None = None,
) -> dict | None:
    """Spawn an agent conversation for `initial_message`.

    Generates a threadId, POSTs the task to the agent-host /agui endpoint, and
    consumes the AG-UI SSE stream until RUN_FINISHED, accumulating the final
    assistant message. Returns {conversation_id, result} or None on failure.

    `repository` is woven into the task text (the agent works in its sandbox).

    `on_created`, if given, is awaited with the conversation_id BEFORE the agent
    run starts — the run blocks until RUN_FINISHED, and the agent may call a
    response tool (e.g. slack_respond) on its very first turn, so the target
    link/mapping MUST be registered up front or that first reply has nothing to
    infer its thread from (the Slack "first message escapes the thread" bug). A
    hook failure is logged, not fatal — the run proceeds.
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

    if on_created is not None:
        try:
            await on_created(conversation_id)
        except Exception:
            logger.exception("create_conversation on_created hook failed (continuing)")

    try:
        result_text = await _run_and_collect(payload, owner=owner)
    except RunInterrupted:
        # The run was interrupted (agent-host restart) — the conversation exists
        # (created via on_created) and the agent-host resumes it on boot. Signal
        # INTERRUPTED (not a failure) so the caller doesn't post "couldn't start".
        logger.warning("create_conversation for %s was interrupted (restart) — agent-host will resume", conversation_id)
        return {"conversation_id": conversation_id, "result": "", "interrupted": True}
    except Exception:
        logger.exception("create_conversation failed")
        return None

    return {"conversation_id": conversation_id, "result": result_text}


async def send_message(conversation_id: str, message: str, *, priority: bool = False) -> bool:
    """Send a follow-up message into an existing conversation (same thread).

    `priority=True` (an @mention to an ACTIVE conversation) tags the forward so the
    agent-host can force-interrupt a stuck turn after its priority timeout. The
    agent-host owns the timer; webhooks only flags intent. PRIORITY_INTERRUPT=10
    mirrors the agent-host's bridge constant.
    """
    payload = {
        "threadId": conversation_id,
        "runId": str(uuid.uuid4()),
        "messages": [{"role": "user", "content": message}],
    }
    if priority:
        payload["priority"] = 10  # PRIORITY_INTERRUPT (agent-host bridge.ts)
    try:
        await _run_and_collect(payload)
        return True
    except Exception:
        logger.exception("send_message failed for %s", conversation_id)
        return False


class RunInterrupted(Exception):
    """The /agui SSE dropped before RUN_FINISHED — e.g. the agent-host pod
    restarted mid-run. This is TRANSIENT: the agent-host resumes interrupted
    conversations on boot, so the caller must NOT declare a hard failure (no
    "couldn't start" post). Distinct from a RUN_ERROR (the agent genuinely
    failed)."""


async def _run_and_collect(payload: dict, owner: str | None = None) -> str:
    """POST a RunAgentInput to /agui and accumulate the final assistant text from
    the AG-UI SSE stream (TEXT_MESSAGE_CONTENT deltas), returning on RUN_FINISHED.

    `owner` (a resolved Scooter user id) is sent as the TRUSTED x-scooter-owner
    HEADER — never in the body — so the agent-host stamps it as the conversation
    owner. (The header is honored only from this in-cluster path; the ingress strips
    it from browser requests.)

    Raises RunInterrupted if the connection drops before RUN_FINISHED (a restart);
    raises RuntimeError on a RUN_ERROR (a genuine agent failure).
    """
    text_parts: list[str] = []
    saw_finished = False
    headers = {"Accept": "text/event-stream"}
    if owner:
        headers["x-scooter-owner"] = owner
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST", _agui_url(), json=payload, headers=headers
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
                        saw_finished = True
                        break
                    elif etype == "RUN_ERROR":
                        raise RuntimeError(event.get("message", "agent run error"))
    except httpx.HTTPError as e:
        # Transport-level drop (connection reset, agent-host restart, read timeout).
        # The run may be resuming on the agent-host — treat as interrupted, not failed.
        raise RunInterrupted(str(e)) from e
    if not saw_finished:
        # The stream ended cleanly but before RUN_FINISHED (server closed mid-run,
        # e.g. a graceful restart) — also interrupted, not a completed run.
        raise RunInterrupted("stream ended before RUN_FINISHED")
    return "".join(text_parts).strip()


async def push_link(
    conversation_id: str,
    *,
    source: str,
    resource_type: str,
    url: str | None = None,
    title: str | None = None,
    ref: dict | None = None,
) -> bool:
    """Record an external resource link (the PR/issue/thread this conversation
    came from) on the agent-host, so the UI's linked-resources panel can show it.

    `ref` carries structured target identifiers (e.g. slack channel/threadTs,
    github owner/repo/number) so the agent-host's response tools can infer where
    to reply without the agent supplying them. Best-effort — a failure must not
    break the webhook flow."""
    base = settings.agent_host_url.rstrip("/")
    body: dict = {"source": source, "resourceType": resource_type, "url": url, "title": title}
    if ref is not None:
        body["ref"] = ref
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{base}/conversations/{conversation_id}/links",
                json=body,
            )
            return resp.status_code in (200, 201)
    except httpx.HTTPError:
        logger.warning("push_link failed for %s (%s/%s)", conversation_id, source, resource_type)
        return False


async def get_conversation_status(conversation_id: str) -> str | None:
    """Status of a conversation via the agent-host management API.

    Returns the status string, or None when it can't be determined. Finding #17:
    a 404 (conversation gone) and a transient failure (5xx / agent-host
    unreachable) BOTH yield None, but they're very different — the former is
    terminal, the latter means "try again". They're logged DISTINCTLY (404 at
    debug, transient at warning) so a persistently-unreachable agent-host is
    visible instead of silently looking like every conversation vanished.
    """
    base = settings.agent_host_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base}/conversations/{conversation_id}")
            if resp.status_code == 404:
                logger.debug("conversation %s not found (404) — no status", conversation_id)
                return None
            resp.raise_for_status()
            return resp.json().get("status")
    except httpx.HTTPError as e:
        # Transient: the agent-host is unreachable or erroring. NOT the same as a
        # 404 — surface it so a flapping/dead agent-host doesn't silently freeze
        # all status comments.
        logger.warning("status fetch for %s FAILED (transient, will retry): %s", conversation_id, e)
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
