"""Open the handed-off conversation: the tool calls it directly, or Approve does."""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from scooter_broker_lib.autolink import Link, post_link
from scooter_broker_lib.owner import OwnerResolver
from scooter_lib.logging_config import format_error

from . import HANDOFF_SOURCE
from .agent_host import AgentHost, SpawnError

logger = logging.getLogger(__name__)


class SpawnFailed(Exception):
    """The spawn did not happen; the message is for the agent."""


@dataclass
class Spawner:
    agent_host: AgentHost
    base_url: str = ""
    owners: OwnerResolver | None = None

    def url(self, conversation_id: str) -> str:
        base = self.base_url.rstrip("/")
        return f"{base}/?thread={conversation_id}" if base else conversation_id

    async def spawn(
        self, source_id: str, *, brief: str, title: str, model: str, folder: str | None = None,
    ) -> dict:
        """Spawn, link both ways and file it in the owner's `folder` if one is named.

        Returns the new conversation's id, url and visibility, and with a folder
        whether it was filed: a spawn that did not file still happened.
        """
        owner = await self._owner(source_id)
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
        out = {"conversation_id": new_id, "url": self.url(new_id), "visibility": made.get("visibility")}
        if folder:
            out["filed"] = await self._file(owner, new_id, folder)
        return out

    async def _file(self, owner: str, conversation_id: str, folder: str) -> bool:
        try:
            await self.agent_host.file(owner, conversation_id, folder)
        except httpx.HTTPError as e:
            logger.warning("handoff filing failed", extra={"conversation_id": conversation_id, "error": format_error(e)})
            return False
        return True

    async def _owner(self, source_id: str) -> str:
        """The source's owner; refuses a private source with other authors."""
        access = await self.owners.access(source_id) if self.owners else None
        if access is None:
            raise SpawnFailed("handoff failed: could not look up this conversation")
        if access.visibility == "private" and access.acting_user is None:
            raise SpawnFailed(
                "handoff refused: this private conversation holds text its owner didn't write. "
                "Ask the user to start the new conversation themselves."
            )
        return access.owner or ""

    def _prompt(self, brief: str, source_id: str) -> str:
        # The same owner can read the source, private or not.
        return "\n".join([
            brief, "", "---", f"Handed off from conversation {source_id} ({self.url(source_id)}).",
            f'Read its history with handoff_read(conversation_id="{source_id}") if the brief leaves a gap.',
        ])
