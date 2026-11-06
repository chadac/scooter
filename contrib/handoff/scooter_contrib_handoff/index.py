"""One pass of the search index: fold changed shared conversations in, drop vanished ones."""

from __future__ import annotations

import logging
import httpx

from .agent_host import AgentHost
from .store import HandoffStore

logger = logging.getLogger(__name__)

# Only the newest window of a conversation is indexed.
MAX_EVENTS = 2000
MAX_MESSAGE_CHARS = 4000
# Bounded per pass, so a backlog spreads over runs.
MAX_CONVERSATIONS = 50


async def reindex(store: HandoffStore, agent_host: AgentHost) -> dict[str, int]:
    rows = {
        row["id"]: row for row in await agent_host.shared()
        if row.get("id") and not row.get("parentId") and isinstance(row.get("lastActivityAt"), (int, float))
    }
    indexed = await store.indexed()
    # Private, deleted and subagent conversations leave the index.
    gone = [cid for cid in indexed if cid not in rows]
    changed = sorted(
        (row for cid, row in rows.items() if int(row["lastActivityAt"]) > indexed.get(cid, -1)),
        key=lambda row: row["lastActivityAt"], reverse=True,
    )
    done = 0
    for row in changed[:MAX_CONVERSATIONS]:
        try:
            page = await agent_host.messages(row["id"], before=2**53 - 1, limit=MAX_EVENTS)
        except httpx.HTTPError as e:
            logger.warning("transcript read failed", extra={"conversation_id": row["id"], "error": str(e)})
            continue
        if page is None:
            gone.append(row["id"])
            continue
        await store.replace_conversation(
            row["id"], title=row.get("title") or "", owner=row.get("owner"),
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
