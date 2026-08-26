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
from .logging_config import format_error

logger = logging.getLogger(__name__)
_C = {"component": "agent_host_client"}


def _agui_url() -> str:
    return f"{settings.agent_host_url.rstrip('/')}/agui"


def _conversations_url() -> str:
    return f"{settings.agent_host_url.rstrip('/')}/conversations"


async def _create_conversation(owner: str | None) -> str | None:
    """Ask the server for a conversation id (POST /conversations). None on failure."""
    headers = {"content-type": "application/json"}
    token = _sa_token()
    if token:
        headers["authorization"] = f"Bearer {token}"
    if owner:
        headers["x-auth-user"] = owner
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(_conversations_url(), json={}, headers=headers)
        if resp.status_code >= 300:
            logger.error(
                "create conversation returned an error status",
                extra={**_C, "status": resp.status_code, "path": "/conversations"},
            )
            return None
        return resp.json().get("id")
    except (httpx.HTTPError, ValueError) as e:
        logger.error(
            "create conversation request failed",
            extra={**_C, "path": "/conversations", "error": format_error(e)},
        )
        return None


def _content(
    text: str, images: list[dict] | None, files: list[dict] | None = None
) -> str | list[dict]:
    """Build a message's `content`: a plain string (text-only, the common case) OR
    a multimodal parts array (text + image + file parts) the agent-host /agui
    normalizer splits. Each image is {data: base64, mimeType}; each file is
    {name, data: base64, mimeType} (a binary attachment the agent-host writes into
    the sandbox). The inlined-text block for text attachments is woven into `text`
    by the CALLER, not here. Mirrors the UI's send shape."""
    if not images and not files:
        return text
    parts: list[dict] = []
    if text:
        parts.append({"type": "text", "text": text})
    for img in images or []:
        parts.append({"type": "image", "data": img["data"], "mimeType": img["mimeType"]})
    for f in files or []:
        parts.append(
            {"type": "file", "name": f["name"], "data": f["data"], "mimeType": f["mimeType"]}
        )
    return parts


async def create_conversation(
    initial_message: str,
    repository: str | None = None,
    git_provider: str = "github",
    title: str | None = None,
    on_created: Callable[[str], Awaitable[None]] | None = None,
    owner: str | None = None,
    images: list[dict] | None = None,
    files: list[dict] | None = None,
    source: str | None = None,
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
    conversation_id = await _create_conversation(owner)
    if conversation_id is None:
        return None  # nothing to prompt
    task = initial_message
    if repository:
        task = f"Repository: {repository}\n\n{task}"

    payload = {
        "threadId": conversation_id,
        "runId": str(uuid.uuid4()),
        "messages": [{"role": "user", "content": _content(task, images, files)}],
    }
    if source:
        # Mark this as a SYSTEM message (a webhook event, not a human turn) — the
        # agent-host decorates the prompt + the UI hides it. e.g. "github", "slack".
        payload["source"] = source
    if owner:
        # The resolved Scooter owner rides the body; the agent-host honors it only for
        # this TRUSTED caller (our SA token, verified via TokenReview — see _sa_token).
        payload["owner"] = owner

    if on_created is not None:
        try:
            await on_created(conversation_id)
        except Exception:
            logger.exception(
                "on_created hook failed",
                extra={**_C, "conversation_id": conversation_id, "continuing": True},
            )

    try:
        result_text = await _run_and_collect(payload)
    except RunInterrupted:
        # The run was interrupted (agent-host restart) — the conversation exists
        # (created via on_created) and the agent-host resumes it on boot. Signal
        # INTERRUPTED (not a failure) so the caller doesn't post "couldn't start".
        logger.warning(
            "run interrupted by restart, agent-host will resume",
            extra={**_C, "conversation_id": conversation_id},
        )
        return {"conversation_id": conversation_id, "result": "", "interrupted": True}
    except RunErrored as e:
        # The agent CRASHED mid-run. The conversation EXISTS (on_created posted the
        # link + anchor) and did work — so this is NOT "couldn't start". Signal
        # ERRORED (with the message) so the caller posts a truthful "hit an error
        # partway through" note, not a create-failed one.
        logger.warning(
            "run errored mid-run",
            extra={**_C, "conversation_id": conversation_id, "error": format_error(e)},
        )
        return {"conversation_id": conversation_id, "result": "", "errored": True, "error": str(e)}
    except Exception:
        # A GENUINE early failure BEFORE the run produced anything (rare — on_created
        # already ran by here, so the conversation usually exists; this is the
        # can't-actually-create case). Return None → the caller's "couldn't start".
        logger.exception(
            "create conversation failed",
            extra={**_C, "conversation_id": conversation_id},
        )
        return None

    return {"conversation_id": conversation_id, "result": result_text}


async def send_message(
    conversation_id: str,
    message: str,
    *,
    priority: bool = False,
    images: list[dict] | None = None,
    files: list[dict] | None = None,
    source: str | None = None,
) -> bool:
    """Send a follow-up message into an existing conversation (same thread).

    `priority=True` (an @mention to an ACTIVE conversation) tags the forward so the
    agent-host can force-interrupt a stuck turn after its priority timeout. The
    agent-host owns the timer; webhooks only flags intent. PRIORITY_INTERRUPT=10
    mirrors the agent-host's bridge constant. `images` (base64 + mime) attach as
    multimodal content parts.
    """
    payload = {
        "threadId": conversation_id,
        "runId": str(uuid.uuid4()),
        "messages": [{"role": "user", "content": _content(message, images, files)}],
    }
    if source:
        payload["source"] = source  # a system message (webhook follow-up), not a human turn
    if priority:
        payload["priority"] = 10  # PRIORITY_INTERRUPT (agent-host bridge.ts)
    try:
        await _run_and_collect(payload)
        return True
    except Exception:
        logger.exception(
            "send message failed",
            extra={**_C, "conversation_id": conversation_id},
        )
        return False


class RunInterrupted(Exception):
    """The /agui SSE dropped before RUN_FINISHED — e.g. the agent-host pod
    restarted mid-run. This is TRANSIENT: the agent-host resumes interrupted
    conversations on boot, so the caller must NOT declare a hard failure (no
    "couldn't start" post). Distinct from a RunErrored (the agent genuinely
    failed)."""


class RunErrored(Exception):
    """A RUN_ERROR arrived on the /agui stream — the agent ran but CRASHED mid-task.
    Crucially the conversation ALREADY EXISTS (on_created ran: the link/anchor were
    posted) and the agent did real work; it just errored partway. So the caller must
    NOT post "couldn't start" — the conversation is there. Carries the error message
    for a truthful "hit an error partway through" note."""


def _sa_token() -> str | None:
    """Read the projected ServiceAccount token the agent-host TokenReview verifies
    (proving we're the trusted webhooks caller, so it honors `payload.owner`). None
    if not mounted — the owner is then ignored agent-host-side (unowned)."""
    path = settings.agent_host_token_path
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


async def _run_and_collect(payload: dict) -> str:
    """POST a RunAgentInput to /agui and accumulate the final assistant text from
    the AG-UI SSE stream (TEXT_MESSAGE_CONTENT deltas), returning on RUN_FINISHED.

    Sends our SA token as `Authorization: Bearer` so the agent-host can verify us as
    the trusted webhooks caller (TokenReview) and honor `payload.owner`.

    Raises RunInterrupted if the connection drops before RUN_FINISHED (a restart);
    raises RunErrored on a RUN_ERROR (the agent crashed mid-run — the conversation
    still exists).
    """
    text_parts: list[str] = []
    saw_finished = False
    headers = {"Accept": "text/event-stream"}
    token = _sa_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
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
                        # The agent CRASHED mid-run (not a transport drop). The
                        # conversation already exists + did work — see RunErrored.
                        raise RunErrored(event.get("message", "agent run error"))
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
    except httpx.HTTPError as e:
        logger.warning(
            "push link failed",
            extra={
                **_C,
                "conversation_id": conversation_id,
                "source": source,
                "resource_type": resource_type,
                "error": format_error(e),
            },
        )
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
                logger.debug(
                    "conversation not found, no status",
                    extra={**_C, "conversation_id": conversation_id, "status": 404},
                )
                return None
            resp.raise_for_status()
            return resp.json().get("status")
    except httpx.HTTPError as e:
        # Transient: the agent-host is unreachable or erroring. NOT the same as a
        # 404 — surface it so a flapping/dead agent-host doesn't silently freeze
        # all status comments.
        logger.warning(
            "status fetch failed, transient, will retry",
            extra={**_C, "conversation_id": conversation_id, "error": format_error(e)},
        )
        return None


async def get_conversation_statuses(conversation_ids: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for cid in conversation_ids:
        status = await get_conversation_status(cid)
        if status:
            out[cid] = status
    return out


async def find_conversations_by_url(url: str, owner: str | None = None) -> list[str]:
    """Reverse lookup: find all conversations that link to a given URL.
    
    Used for webhook routing — find the conversation(s) that own a PR/MR/issue
    so check failures and comments can be routed back to the right conversation.
    
    Args:
        url: The resource URL (e.g. https://github.com/owner/repo/pull/42)
        owner: Optional owner email for scoped lookup (multi-tenant safety)
    
    Returns:
        List of conversation IDs that link to the URL (empty if none found)
    """
    import urllib.parse
    params = {"url": url}
    if owner:
        params["owner"] = owner
    query_string = urllib.parse.urlencode(params)
    
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get(
                f"{settings.agent_manager_url}/links/by-url?{query_string}",
                headers=_auth_headers(),
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json()
            return data.get("conversationIds", [])
        except Exception:
            logger.exception("find_conversations_by_url failed for %s", url)
            return []


async def resolve_sandbox_to_conversation(sandbox_or_conv_id: str) -> str | None:
    """conversation_id == threadId, so it resolves to itself."""
    return sandbox_or_conv_id


def conversation_url(conversation_id: str) -> str:
    base = settings.agent_manager_url.rstrip("/")
    return f"{base}/?thread={conversation_id}" if base else conversation_id
