"""The agent-host's approval cards for handoff requests.

Best effort: a card that failed to raise comes back when the host re-lists
/handoff/spawns/pending on revive.
"""

from __future__ import annotations

import logging
from typing import Protocol

import httpx

from scooter_broker_lib.autolink import router_headers
from scooter_lib.logging_config import format_error

from .store import SpawnRequest

logger = logging.getLogger(__name__)

CONTRIB = "handoff"
KIND = "handoff.spawn"

# Brief characters shown on the card; the rest is elided.
_CARD_BRIEF = 1500


def card(r: SpawnRequest) -> dict:
    """The approval request the host raises; the generic card shows `message`."""
    brief = r.brief if len(r.brief) <= _CARD_BRIEF else r.brief[:_CARD_BRIEF] + " …"
    head = f"The agent wants to hand off to a new conversation: {r.title or 'Handoff'}"
    if r.model:
        head += f" (model {r.model})"
    return {
        "request_id": r.id,
        "message": f"{head}.\n\nBrief:\n{brief}",
        "kind": KIND,
        "data": {"title": r.title, "model": r.model, "brief": r.brief},
    }


class Cards(Protocol):
    async def raise_(self, r: SpawnRequest) -> None: ...


class NoCards:
    async def raise_(self, r: SpawnRequest) -> None:
        return None


class HostCards:
    def __init__(self, agent_host_url: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._base = agent_host_url.rstrip("/")
        self._transport = transport

    async def raise_(self, r: SpawnRequest) -> None:
        extra = {"conversation_id": r.conversation_id, "request_id": r.id}
        try:
            async with httpx.AsyncClient(base_url=self._base, timeout=10, transport=self._transport) as c:
                resp = await c.post(
                    f"/conversations/{r.conversation_id}/approvals/{CONTRIB}", headers=router_headers(), json=card(r),
                )
        except httpx.HTTPError as e:
            logger.warning("handoff approval card failed", extra={**extra, "error": format_error(e)})
            return
        if resp.status_code >= 300:
            logger.warning("handoff approval card refused", extra={**extra, "status": resp.status_code})
