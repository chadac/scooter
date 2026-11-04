"""Agent-host client: spawn and drive agent conversations from webhooks.

A conversation is spawned by POSTing the task to the agent-host's AG-UI endpoint
(POST /agui, the same path the UI uses) and reading the SSE stream until the run
finishes. The conversation_id is the threadId, so it is known up front.
"""

from __future__ import annotations

import asyncio
import enum
import json
import logging
import uuid
from collections.abc import Awaitable, Callable
from typing import Protocol

import httpx
from scooter_lib.logging_config import format_error, pseudonym

from .sender import Sender

logger = logging.getLogger(__name__)
_C = {"component": "agent_host_client"}


class AgentHostConfig(Protocol):
    """What this client needs from the settings object the app hands it; a lib module never reads the environment itself."""

    agent_host_url: str
    agent_host_token_path: str
    agent_manager_url: str


_config: AgentHostConfig | None = None


def init(config: AgentHostConfig) -> None:
    """Bind the agent-host settings once at service startup."""
    global _config
    _config = config


def _cfg() -> AgentHostConfig:
    if _config is None:
        raise RuntimeError("scooter_webhooks_lib.agent_host_client.init(config) was never called")
    return _config


def _agui_url() -> str:
    return f"{_cfg().agent_host_url.rstrip('/')}/agui"


def _conversations_url() -> str:
    return f"{_cfg().agent_host_url.rstrip('/')}/conversations"


async def _create_conversation(owner: str | None) -> str | None:
    """Ask the server for a conversation id (POST /conversations), or None on failure; `owner` rides the body because the identity header's name is deployment-configurable."""
    headers = {"content-type": "application/json", **_auth()}
    body: dict = {}
    if owner:
        body["owner"] = owner
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(_conversations_url(), json=body, headers=headers)
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
    """Build a message's `content`: a plain string, or a multimodal parts array (text, image and file parts) in the UI's send shape."""
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
    sender: Sender | None = None,
) -> dict | None:
    """Spawn an agent conversation for `initial_message` and return {conversation_id, result}, or None on failure.

    `on_created` is awaited with the conversation_id before the run starts, so the
    caller can register the target link before the agent's first reply tool call.
    """
    conversation_id = await _create_conversation(owner)
    if conversation_id is None:
        return None
    task = initial_message
    if repository:
        task = f"Repository: {repository}\n\n{task}"

    payload = {
        "threadId": conversation_id,
        "runId": str(uuid.uuid4()),
        "messages": [{"role": "user", "content": _content(task, images, files)}],
    }
    if source:
        # Marks a system message (a webhook event, not a human turn).
        payload["source"] = source
    if sender is not None:
        payload["sender"] = sender.to_payload()
    if owner:
        # The agent-host honors the owner only for a caller it verified via TokenReview.
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
        # The conversation exists and the agent-host resumes it on boot, so this is not a failure.
        logger.warning(
            "run interrupted by restart, agent-host will resume",
            extra={**_C, "conversation_id": conversation_id},
        )
        return {"conversation_id": conversation_id, "result": "", "interrupted": True}
    except RunErrored as e:
        # The conversation exists and did work, so the caller reports an error partway through rather than a failed start.
        logger.warning(
            "run errored mid-run",
            extra={**_C, "conversation_id": conversation_id, "error": format_error(e)},
        )
        return {"conversation_id": conversation_id, "result": "", "errored": True, "error": str(e)}
    except Exception:
        logger.exception(
            "create conversation failed",
            extra={**_C, "conversation_id": conversation_id},
        )
        return None

    return {"conversation_id": conversation_id, "result": result_text}


class SendOutcome(enum.Enum):
    """What happened to a follow-up message; only NOT_FOUND means the conversation is gone."""

    DELIVERED = "delivered"
    # The agent-host accepted the message, then the run errored or the stream dropped.
    RUN_FAILED = "run_failed"
    NOT_FOUND = "not_found"
    # Never accepted, even after retries.
    UNREACHABLE = "unreachable"


# Backoff before each retry of a message the agent-host never accepted.
SEND_RETRY_DELAYS_S: tuple[float, ...] = (1.0, 2.0, 4.0, 8.0)


async def deliver_message(
    conversation_id: str,
    message: str,
    *,
    priority: bool = True,
    images: list[dict] | None = None,
    files: list[dict] | None = None,
    source: str | None = None,
    sender: Sender | None = None,
) -> SendOutcome:
    """Send a follow-up into an existing conversation. `priority` (the default) interrupts the running turn at its next tool-call boundary; `priority=False` waits for the run to end, which lands the message out of order, so no built-in source uses it. Only a request that was never accepted is retried; retrying after acceptance would duplicate the message."""
    payload = {
        "threadId": conversation_id,
        "runId": str(uuid.uuid4()),
        "messages": [{"role": "user", "content": _content(message, images, files)}],
    }
    if source:
        payload["source"] = source
    if sender is not None:
        payload["sender"] = sender.to_payload()
    if priority:
        payload["priority"] = 10  # PRIORITY_INTERRUPT in the agent-host bridge
    log_extra = {**_C, "conversation_id": conversation_id}
    delays = (*SEND_RETRY_DELAYS_S, None)
    for attempt, delay in enumerate(delays, start=1):
        try:
            await _run_and_collect(payload)
            return SendOutcome.DELIVERED
        except ConversationNotFound as e:
            logger.warning("conversation not found", extra={**log_extra, "error": format_error(e)})
            return SendOutcome.NOT_FOUND
        except RunRejected as e:
            if delay is None:
                logger.error(
                    "send message not accepted, giving up",
                    extra={**log_extra, "attempts": attempt, "error": format_error(e)},
                )
                return SendOutcome.UNREACHABLE
            logger.warning(
                "send message not accepted, retrying",
                extra={**log_extra, "attempt": attempt, "delay_s": delay, "error": format_error(e)},
            )
            await asyncio.sleep(delay)
        except (RunErrored, RunInterrupted) as e:
            logger.warning(
                "send message accepted but the run failed",
                extra={**log_extra, "error": format_error(e)},
            )
            return SendOutcome.RUN_FAILED
        except Exception:
            logger.exception("send message failed", extra=log_extra)
            return SendOutcome.RUN_FAILED
    return SendOutcome.UNREACHABLE  # not reached: the last delay is None


async def send_message(
    conversation_id: str,
    message: str,
    *,
    priority: bool = True,
    images: list[dict] | None = None,
    files: list[dict] | None = None,
    source: str | None = None,
    sender: Sender | None = None,
) -> bool:
    """Send a follow-up message into an existing conversation, True only when the run finished; see deliver_message for `priority`."""
    outcome = await deliver_message(
        conversation_id, message, priority=priority, images=images, files=files, source=source, sender=sender,
    )
    return outcome is SendOutcome.DELIVERED


class RunInterrupted(Exception):
    """The /agui stream dropped before RUN_FINISHED; transient, since the agent-host resumes interrupted conversations on boot."""


class RunRejected(RunInterrupted):
    """The agent-host never accepted the request (connection failure or non-2xx), so retrying cannot duplicate it."""


class RunErrored(Exception):
    """A RUN_ERROR arrived on the /agui stream; the conversation exists and did work before the agent crashed."""


class ConversationNotFound(Exception):
    """The agent-host has no such conversation; the only failure that justifies starting a new one."""


# The RUN_ERROR code agent-host's /agui sets (services/agent-host/src/agui/server.ts).
UNKNOWN_CONVERSATION_CODE = "UNKNOWN_CONVERSATION"
# Matched for an agent-host that predates the codes.
_UNKNOWN_CONVERSATION_PREFIX = "No such conversation:"


def _sa_token() -> str | None:
    """The projected ServiceAccount token that proves we are the trusted webhooks caller, or None if not mounted."""
    path = _cfg().agent_host_token_path
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip() or None
    except OSError:
        return None


def _auth() -> dict[str, str]:
    """The bearer header the conversation-router requires on every agent-host call."""
    token = _sa_token()
    return {"authorization": f"Bearer {token}"} if token else {}


async def _run_and_collect(payload: dict) -> str:
    """POST a RunAgentInput to /agui and return the final assistant text.

    Raises ConversationNotFound if the conversation does not exist, RunRejected if the
    request was never accepted, RunInterrupted if an accepted stream dropped, and
    RunErrored on any other RUN_ERROR.
    """
    text_parts: list[str] = []
    saw_finished = False
    accepted = False
    headers = {"Accept": "text/event-stream", **_auth()}
    try:
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream(
                "POST", _agui_url(), json=payload, headers=headers
            ) as resp:
                if resp.status_code in (404, 410):
                    raise ConversationNotFound(f"agent-host returned {resp.status_code}")
                if resp.status_code >= 300:
                    raise RunRejected(f"agent-host returned {resp.status_code}")
                accepted = True
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
                        message = event.get("message") or "agent run error"
                        if event.get("code") == UNKNOWN_CONVERSATION_CODE or message.startswith(_UNKNOWN_CONVERSATION_PREFIX):
                            raise ConversationNotFound(message)
                        raise RunErrored(message)
    except httpx.HTTPError as e:
        if not accepted:
            raise RunRejected(str(e)) from e
        raise RunInterrupted(str(e)) from e
    if not saw_finished:
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
    """Record an external resource link on the agent-host, best-effort; `ref` carries the structured target the response tools reply to."""
    base = _cfg().agent_host_url.rstrip("/")
    body: dict = {"source": source, "resourceType": resource_type, "url": url, "title": title}
    if ref is not None:
        body["ref"] = ref
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(
                f"{base}/conversations/{conversation_id}/links",
                json=body,
                headers=_auth(),
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
    """Status of a conversation via the agent-host management API, or None; a 404 and a transient failure are logged distinctly."""
    base = _cfg().agent_host_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base}/conversations/{conversation_id}", headers=_auth())
            if resp.status_code == 404:
                logger.debug(
                    "conversation not found, no status",
                    extra={**_C, "conversation_id": conversation_id, "status": 404},
                )
                return None
            resp.raise_for_status()
            return resp.json().get("status")
    except httpx.HTTPError as e:
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


async def resolve_sandbox_to_conversation(sandbox_or_conv_id: str) -> str | None:
    """conversation_id == threadId, so it resolves to itself."""
    return sandbox_or_conv_id


def conversation_url(conversation_id: str) -> str:
    base = _cfg().agent_manager_url.rstrip("/")
    return f"{base}/?thread={conversation_id}" if base else conversation_id


async def user_id_for_email(email: str) -> str | None:
    """Ask the agent-host which Scooter user has this email, or None if no match or unreachable."""
    base = _cfg().agent_host_url.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{base}/users/by-email", params={"email": email}, headers=_auth())
            if resp.status_code != 200:
                return None
            return resp.json().get("id") or None
    except (httpx.HTTPError, ValueError) as e:
        # The domain separates a misconfigured tenant from a missing user without naming a person.
        logger.warning(
            "by-email lookup failed",
            extra={
                **_C,
                "email": pseudonym(email),
                "email_domain": email.rpartition("@")[2] or None,
                "error": format_error(e),
            },
        )
        return None


async def answer_interrupt(
    conversation_id: str,
    interrupt_id: str,
    *,
    answered_by: str,
    email: str | None = None,
    option_id: str,
    result: dict | None = None,
) -> str | None:
    """Answer a pending question as the Scooter user `answered_by`; None on success, else why it was refused."""
    base = _cfg().agent_host_url.rstrip("/")
    headers = {"content-type": "application/json", **_auth()}
    body: dict = {"answeredBy": {"id": answered_by, **({"email": email} if email else {})}, "optionId": option_id}
    if result is not None:
        body["result"] = result
    fields = {**_C, "conversation_id": conversation_id, "interrupt_id": interrupt_id}
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{base}/conversations/{conversation_id}/interrupts/{interrupt_id}/answer",
                json=body,
                headers=headers,
            )
    except httpx.HTTPError as e:
        logger.warning("answering a pending question failed", extra={**fields, "error": format_error(e)})
        return "Scooter is unreachable"
    if resp.status_code < 300:
        return None
    try:
        reason = resp.json().get("error")
    except ValueError:
        reason = None
    logger.info("agent-host refused an answer", extra={**fields, "status": resp.status_code, "reason": reason})
    return reason or f"Scooter refused the answer ({resp.status_code})"
