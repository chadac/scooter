"""Folding conversations into the search index.

Shared conversations are folded by the index task. A user's private ones are folded
when a conversation of theirs searches, since only an owned read can reach them.
"""

from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable

import httpx

from .agent_host import AgentHost
from .store import PRIVATE, SHARED, HandoffStore

logger = logging.getLogger(__name__)

# Only the newest window of a conversation is indexed.
MAX_EVENTS = 2000
MAX_MESSAGE_CHARS = 4000
# Bounded per pass, so a backlog spreads over runs.
MAX_CONVERSATIONS = 50
# Bounded per search, so a first search stays quick.
MAX_OWNED_PER_SEARCH = 20

Fetch = Callable[[str], Awaitable[dict[str, Any] | None]]


async def reindex(store: HandoffStore, agent_host: AgentHost) -> dict[str, int]:
    """One pass over every shared conversation."""

    async def fetch(cid: str) -> dict[str, Any] | None:
        return await agent_host.messages(cid, before=2**53 - 1, limit=MAX_EVENTS)

    rows = _top_level(await agent_host.shared())
    return await _fold(store, rows, await store.indexed(SHARED), fetch, SHARED, MAX_CONVERSATIONS)


async def refresh_owned(
    store: HandoffStore, agent_host: AgentHost, source_id: str, owned: list[dict[str, Any]], owner: str,
) -> dict[str, int]:
    """Fold the owner's changed private conversations in, read through `source_id`."""

    async def fetch(cid: str) -> dict[str, Any] | None:
        return await agent_host.owned_messages(source_id, cid, before=2**53 - 1, limit=MAX_EVENTS)

    rows = _top_level(row for row in owned if row.get("visibility") == PRIVATE)
    return await _fold(store, rows, await store.indexed(PRIVATE, owner), fetch, PRIVATE, MAX_OWNED_PER_SEARCH)


def _top_level(rows) -> dict[str, dict[str, Any]]:
    return {
        row["id"]: row for row in rows
        if row.get("id") and not row.get("parentId") and isinstance(row.get("lastActivityAt"), (int, float))
    }


async def _fold(
    store: HandoffStore, rows: dict[str, dict[str, Any]], indexed: dict[str, int], fetch: Fetch,
    visibility: str, limit: int,
) -> dict[str, int]:
    # Deleted, subagent and re-scoped conversations leave this part of the index.
    gone = [cid for cid in indexed if cid not in rows]
    changed = sorted(
        (row for cid, row in rows.items() if int(row["lastActivityAt"]) > indexed.get(cid, -1)),
        key=lambda row: row["lastActivityAt"], reverse=True,
    )
    done = 0
    for row in changed[:limit]:
        try:
            page = await fetch(row["id"])
        except httpx.HTTPError as e:
            logger.warning("transcript read failed", extra={"conversation_id": row["id"], "error": str(e)})
            continue
        if page is None:
            gone.append(row["id"])
            continue
        await store.replace_conversation(
            row["id"], title=row.get("title") or "", owner=row.get("owner"), visibility=visibility,
            last_activity_at=int(row["lastActivityAt"]), messages=_messages(page),
        )
        done += 1
    await store.remove_conversations(gone)
    return {"indexed": done, "removed": len(gone), "pending": max(0, len(changed) - done)}


def _messages(page: dict) -> list[tuple[str, str]]:
    out = []
    for m in page.get("messages", []):
        content = m.get("content")
        if m.get("role") in ("user", "assistant") and isinstance(content, str) and content.strip():
            out.append((m["role"], content.strip()[:MAX_MESSAGE_CHARS]))
    return out
