"""Messages kanban sends a conversation, e.g. that the cards blocking it are done."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Awaitable, Callable

import httpx
from scooter_broker_lib.autolink import router_headers

# A system source, so it never reads as the user.
SOURCE = "kanban"

# conversation id, text -> delivered.
Send = Callable[[str, str], Awaitable[None]]


@dataclass
class AgentHostMessages:
    agent_host_url: str
    timeout: float = 10.0
    # For tests (httpx.MockTransport).
    transport: httpx.AsyncBaseTransport | None = None

    async def __call__(self, conversation_id: str, text: str) -> None:
        """Queue `text` on the conversation; raises httpx.HTTPError when it isn't accepted."""
        async with httpx.AsyncClient(
            base_url=self.agent_host_url.rstrip("/"), timeout=self.timeout, headers=router_headers(), transport=self.transport
        ) as c:
            r = await c.post(f"/conversations/{conversation_id}/messages", json={"text": text, "source": SOURCE})
        r.raise_for_status()
