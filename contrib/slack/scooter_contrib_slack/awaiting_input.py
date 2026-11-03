"""Post a conversation's pending question or approval to its Slack thread.

The agent-host POSTs `/slack/awaiting-input` when a conversation starts waiting on the
user (`services.broker.notifyAwaitingInput`). A conversation started from Slack would
otherwise sit silently blocked, since its Slack user never sees the UI's card. Answering
still happens in the UI; the message says what is asked and links there.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException

from scooter_broker_lib.links import first_target
from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport
from scooter_lib.logging_config import format_error

from .mcp_tools import SOURCE, target_from_link

logger = logging.getLogger(__name__)


@dataclass
class AwaitingInputNotice(Transport):
    """`POST /awaiting-input`, called by the agent-host only."""

    name: str = "slack-awaiting-input"
    upstream: str = "https://slack.com/api"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()

        @router.post("/awaiting-input")
        async def awaiting_input(notice: dict = Body(...), identity: Identity = Depends(authed)) -> dict:
            # The agent-host is the approver account; a sandbox must not post as the bot.
            if not identity.is_approver:
                raise HTTPException(status_code=403, detail="only the agent-host sends awaiting-input notices")
            target = first_target(notice.get("links") or [], SOURCE, target_from_link)
            if target is None:
                return {"posted": False, "reason": "no Slack thread linked"}
            if provider.credential is None:
                raise HTTPException(status_code=503, detail="slack has no bot token")
            payload: dict[str, Any] = {
                "channel": target["channel"],
                "text": format_notice(notice),
                "unfurl_links": False,
                "unfurl_media": False,
            }
            if target.get("thread_ts"):
                payload["thread_ts"] = target["thread_ts"]
            fields = {"conversation_id": notice.get("conversationId"), "channel": target["channel"]}
            async with httpx.AsyncClient(timeout=15) as client:
                req = client.build_request("POST", f"{self.upstream.rstrip('/')}/chat.postMessage", json=payload)
                (await provider.credential.get(identity)).inject(req)
                try:
                    resp = await client.send(req)
                    data = resp.json()
                except (httpx.HTTPError, ValueError) as e:
                    logger.warning("posting a pending question to Slack failed", extra={**fields, "error": format_error(e)})
                    raise HTTPException(status_code=502, detail="slack unreachable") from e
            if not data.get("ok"):
                logger.warning("slack refused a pending question", extra={**fields, "slack_error": data.get("error")})
                raise HTTPException(status_code=502, detail=f"slack: {data.get('error') or 'unknown error'}")
            return {"posted": True, "ts": data.get("ts")}

        return router


ASK_USER_KIND = "ask-user.questions"
# Slack rejects a message's text past 40k characters; stay well under.
MAX_TEXT = 3500


def _escape(text: Any) -> str:
    """Slack's three control characters, so agent text cannot forge links or mentions."""
    return str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _questions(data: Any) -> list[dict]:
    raw = data.get("questions") if isinstance(data, dict) else None
    return [q for q in raw if isinstance(q, dict) and q.get("question")] if isinstance(raw, list) else []


def _question_lines(q: dict) -> list[str]:
    header = f"*{_escape(q['header'])}:* " if q.get("header") else ""
    pick = " _(pick any)_" if q.get("multiSelect") else ""
    lines = [f"{header}{_escape(q['question'])}{pick}"]
    for opt in q.get("options") or []:
        if not isinstance(opt, dict) or not opt.get("label"):
            continue
        desc = f" — {_escape(opt['description'])}" if opt.get("description") else ""
        lines.append(f"    • {_escape(opt['label'])}{desc}")
    return lines


def format_notice(notice: dict) -> str:
    """The thread message for one pending interrupt, in Slack mrkdwn."""
    interrupt = notice.get("interrupt") or {}
    questions = _questions(interrupt.get("data")) if interrupt.get("kind") == ASK_USER_KIND else []
    if questions:
        noun = "a question" if len(questions) == 1 else f"{len(questions)} questions"
        lines = [f":question: I have {noun} and I'm waiting for your answer:"]
        for q in questions:
            lines += ["", *_question_lines(q)]
    else:
        message = _escape(interrupt.get("message") or "I need your input")
        lines = [f":raised_hand: I'm waiting on you: {message}"]
        names = [_escape(o.get("name")) for o in interrupt.get("options") or [] if isinstance(o, dict) and o.get("name")]
        if names:
            lines.append(f"Choices: {' / '.join(names)}")
    text = "\n".join(lines)
    if len(text) > MAX_TEXT:
        text = text[: MAX_TEXT - 1] + "…"
    url = notice.get("conversationUrl")
    if url:
        text += f"\n\n<{url}|Answer in Scooter>"
    return text
