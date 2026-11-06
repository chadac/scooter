"""handoff's agent tools: spawn a conversation, search and read shared ones.

The source conversation always comes from the verified conversation token, never an
argument, and the router derives the new conversation's owner and visibility from it.
"""

from __future__ import annotations

import json
import logging

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult
from scooter_broker_lib.owner import OwnerResolver

from .agent_host import AgentHost
from .host import Cards, NoCards
from .spawn import SpawnFailed, Spawner
from .store import HandoffStore, Refused

logger = logging.getLogger(__name__)

mcp = FastMCP(name="handoff")

_MAX_BRIEF = 48 * 1024
_MAX_READ_CHARS = 2000

# Set by the provider factory.
_store: HandoffStore | None = None
_agent_host: AgentHost | None = None
_spawner: Spawner | None = None
_owners: OwnerResolver | None = None
_cards: Cards = NoCards()
_require_approval = True


def configure(
    store: HandoffStore | None, agent_host: AgentHost | None, base_url: str, *,
    owners: OwnerResolver | None = None, cards: Cards | None = None, require_approval: bool = True,
) -> None:
    global _store, _agent_host, _spawner, _owners, _cards, _require_approval
    _store, _agent_host, _owners = store, agent_host, owners
    _spawner = Spawner(agent_host, base_url) if agent_host else None
    _cards = cards or NoCards()
    _require_approval = require_approval


def conversation_url(conversation_id: str) -> str:
    return _spawner.url(conversation_id) if _spawner else conversation_id


@mcp.tool
async def handoff_spawn(
    brief: str, title: str = "", model: str = "",
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Hand a task to a NEW top-level conversation, with its own sandbox and its own
    place in the user's sidebar, and start it with `brief` as its first message.

    Only when the user asks for one, or agrees to your offer: otherwise use
    spawn_subagent. Prefer this when the work outlives this turn, needs its own
    sandbox, or the user should drive it separately. It is not a subagent: nothing
    reports back here. The new conversation has the same owner and visibility as this
    one, and none of this conversation's history or files, so `brief` must stand
    alone: the goal, what is done, what is left, repos, branches and decisions.
    Push work in progress to a branch first and name it.

    Usually the conversation's owner must approve it first: the call returns at once,
    and a message tells you the new conversation, or that it was denied.
    """
    if _store is None or _spawner is None:
        return ToolResult.error("handoff is not configured here")
    source_id = ctx.identity.conversation_id
    if not source_id:
        return ToolResult.error("no conversation for this caller")
    brief, title, model = brief.strip(), title.strip(), model.strip()
    if not brief:
        return ToolResult.error("brief is required")
    if len(brief) > _MAX_BRIEF:
        return ToolResult.error(f"brief exceeds {_MAX_BRIEF} bytes; push detail to a branch and name it")

    if not _require_approval:
        try:
            return ToolResult.ok(json.dumps(await _spawner.spawn(source_id, brief=brief, title=title, model=model)))
        except SpawnFailed as e:
            return ToolResult.error(str(e))

    access = await _owners.access(source_id) if _owners else None
    if access is None or not access.owner:
        return ToolResult.error("handoff needs the owner's approval, and this conversation has no known owner")
    try:
        req = await _store.request_spawn(source_id, access.owner, brief=brief, title=title, model=model)
    except Refused as e:
        return ToolResult.error(f"handoff refused: {e}")
    await _cards.raise_(req)
    return ToolResult.ok(json.dumps({
        "status": "pending_approval", "request_id": req.id,
        "note": "The user must approve this handoff. A message will tell you the outcome; do not retry.",
    }))


@mcp.tool
async def handoff_search(query: str, limit: int = 10, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Search past SHARED conversations by what was said in them (full-text, English
    stemming; quotes, OR and -word work). Returns one hit per conversation with a
    snippet; read one with handoff_read. Private conversations and subagents are never
    indexed, and the index trails live activity by a few minutes.
    """
    if _store is None or _agent_host is None:
        return ToolResult.error("handoff is not configured here")
    if not query.strip():
        return ToolResult.error("query is required")
    limit = max(1, min(limit, 25))
    hits = await _store.search(query, limit * 2, exclude={ctx.identity.conversation_id})
    # The live list catches a newly private conversation.
    shared = {row["id"] for row in await _agent_host.shared()}
    out = [
        {
            "conversation_id": h.conversation_id, "title": h.title, "owner": h.owner,
            "last_activity_ms": h.last_activity_at, "url": conversation_url(h.conversation_id),
            "snippet": h.snippet, "score": h.score,
        }
        for h in hits if h.conversation_id in shared
    ][:limit]
    return ToolResult.ok(json.dumps(out, indent=1) if out else "No shared conversation matches.")


@mcp.tool
async def handoff_read(
    conversation_id: str, before: int = 0, limit: int = 600, ctx: ToolContext = ToolContextDep
) -> ToolResult:
    """Read a SHARED conversation's user and assistant messages, newest page first.

    Each message is clipped to 2000 characters. To page back, pass the returned
    `next_before` as `before`; it is null at the start of the conversation. `limit`
    counts history events per page (a message is several), capped at 3000.
    """
    if _agent_host is None:
        return ToolResult.error("handoff is not configured here")
    page = await _agent_host.messages(
        conversation_id, before=before if before > 0 else 2**53 - 1, limit=max(1, min(limit, 3000)),
    )
    if page is None:
        return ToolResult.error("no such shared conversation (private conversations cannot be read)")
    messages = [
        {"role": m["role"], "text": _clip(m["content"])}
        for m in page.get("messages", [])
        if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str) and m["content"].strip()
    ]
    conv = await _agent_host.conversation(conversation_id) or {}
    return ToolResult.ok(json.dumps({
        "title": conv.get("title"), "owner": conv.get("owner"), "url": conversation_url(conversation_id),
        "messages": messages, "next_before": None if page.get("done") else page.get("fromSeq"),
    }, indent=1))


def _clip(text: str) -> str:
    text = text.strip()
    return text if len(text) <= _MAX_READ_CHARS else text[:_MAX_READ_CHARS] + " …"
