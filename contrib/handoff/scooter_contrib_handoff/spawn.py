"""Open the handed-off conversation: the tool calls it directly, or Approve does."""

from __future__ import annotations

from dataclasses import dataclass

import httpx

from scooter_broker_lib.autolink import Link, post_link

from . import HANDOFF_SOURCE
from .agent_host import AgentHost, SpawnError


class SpawnFailed(Exception):
    """The spawn did not happen; the message is for the agent."""


@dataclass
class Spawner:
    agent_host: AgentHost
    base_url: str = ""

    def url(self, conversation_id: str) -> str:
        base = self.base_url.rstrip("/")
        return f"{base}/?thread={conversation_id}" if base else conversation_id

    async def spawn(self, source_id: str, *, brief: str, title: str, model: str) -> dict:
        """Spawn and link both ways; returns the new conversation's id, url and visibility."""
        try:
            made = await self.agent_host.spawn(
                source_id, prompt=self._prompt(brief, source_id),
                title=title, model=model, source=HANDOFF_SOURCE,
            )
        except SpawnError as e:
            hint = f" A conversation was created anyway: {self.url(e.conversation_id)}" if e.conversation_id else ""
            raise SpawnFailed(f"handoff failed: {e}.{hint}") from None
        except httpx.HTTPError as e:
            raise SpawnFailed(f"handoff failed: router unreachable: {e}") from None

        new_id = made["id"]
        label = title or "Handoff"
        await post_link(self.agent_host.url, source_id, Link("handoff", "conversation", self.url(new_id), f"Handed off: {label}"))
        await post_link(self.agent_host.url, new_id, Link("handoff", "conversation", self.url(source_id), "Handed off from"))
        return {"conversation_id": new_id, "url": self.url(new_id), "visibility": made.get("visibility")}

    def _prompt(self, brief: str, source_id: str) -> str:
        # The same owner can read the source, private or not.
        return "\n".join([
            brief, "", "---", f"Handed off from conversation {source_id} ({self.url(source_id)}).",
            f'Read its history with handoff_read(conversation_id="{source_id}") if the brief leaves a gap.',
        ])
