"""Push a contrib's change onto the conversation state stream."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from scooter_lib.logging_config import format_error

from .autolink import router_headers

logger = logging.getLogger(__name__)

_UNSET: Any = object()


async def publish_state(
    agent_host_url: str,
    conversation_id: str,
    contrib: str,
    data: Any = _UNSET,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> None:
    """Tell open UI sections `contrib` changed; best-effort, never raises."""
    if not agent_host_url or not conversation_id:
        return
    url = f"{agent_host_url.rstrip('/')}/conversations/{conversation_id}/state/contrib/{contrib}"
    body = {} if data is _UNSET else {"data": data}
    extra = {"conversation_id": conversation_id, "contrib": contrib}
    try:
        async with httpx.AsyncClient(timeout=5, transport=transport) as client:
            resp = await client.post(url, json=body, headers=router_headers())
    except httpx.HTTPError as e:
        logger.warning("state publish failed", extra={**extra, "error": format_error(e)})
        return
    if resp.status_code >= 300:
        logger.warning("state publish refused", extra={**extra, "status": resp.status_code})
