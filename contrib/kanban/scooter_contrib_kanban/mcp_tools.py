"""kanban's agent tools: read and set this conversation's card.

The card is always the calling conversation's, from the verified identity, never an
argument, so an agent can only move its own card.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import httpx
from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult

from .config import Column
from .keys import CardKeys
from .store import KanbanStore
from .transport import view

logger = logging.getLogger(__name__)

mcp = FastMCP(name="kanban")

# Set by the provider factory.
_store: KanbanStore | None = None
_columns: list[Column] = []
_stale_after = timedelta(minutes=30)
_keys: CardKeys | None = None


def configure(store: KanbanStore | None, columns: list[Column], stale_after: timedelta, keys: CardKeys | None) -> None:
    global _store, _columns, _stale_after, _keys
    _store, _columns, _stale_after, _keys = store, columns, stale_after, keys


async def _card_key(ctx: ToolContext) -> tuple[str | None, str]:
    """The caller's card key, or None and why not."""
    conversation_id = ctx.identity.conversation_id
    if not conversation_id:
        return None, "kanban needs a conversation identity."
    if _keys is None:
        return None, "kanban cannot reach the agent-host on this deployment."
    try:
        key = await _keys.key(conversation_id)
    except httpx.HTTPError as e:
        logger.warning("kanban card key lookup failed", extra={"conversation_id": conversation_id, "error": str(e)})
        return None, "kanban could not look up this conversation; try again shortly."
    if key is None:
        return None, "kanban does not know this conversation."
    return key, ""


def _column_list() -> str:
    return ", ".join(f"`{c.id}` ({c.label})" for c in _columns)


def _describe(v: dict) -> str:
    card = v["card"]
    label = next((c["label"] for c in v["columns"] if c["id"] == v["column"]), v["column"])
    if card is None:
        return f"No status set yet; the card shows in `{v['column']}` ({label}). Columns: {_column_list()}."
    note = f' Note: "{card["note"]}".' if card["note"] else ""
    return (
        f"The card is in `{v['column']}` ({label}), last set by the {card['updated_by']} at {card['updated_at']}."
        f"{note} Columns: {_column_list()}."
    )


@mcp.tool
async def kanban_set_status(column: str, note: str = "", ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Set this conversation's column on its kanban board, with a one-line note on where
    the work stands.

    Call it when the work changes phase (for example design to in-progress, or
    in-progress to review), and to confirm the status when asked: setting the same
    column again records that it is still right. The valid columns are listed by
    kanban_get_status.
    """
    if _store is None:
        return ToolResult.error("kanban is not configured on this deployment.")
    key, why = await _card_key(ctx)
    if key is None:
        return ToolResult.error(why)
    if column not in {c.id for c in _columns}:
        return ToolResult.error(f"`{column}` is not a column. Use one of: {_column_list()}.")
    card = await _store.put(key, column=column, by="agent", note=note.strip() or None)
    v = view(card, _columns, stale_after=_stale_after, now=datetime.now(timezone.utc))
    return ToolResult.ok(_describe(v))


@mcp.tool
async def kanban_get_status(ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Read this conversation's column and note on its kanban board, and the board's
    valid columns."""
    if _store is None:
        return ToolResult.error("kanban is not configured on this deployment.")
    key, why = await _card_key(ctx)
    if key is None:
        return ToolResult.error(why)
    v = view(await _store.card(key), _columns, stale_after=_stale_after, now=datetime.now(timezone.utc))
    return ToolResult.ok(_describe(v))


def kanban_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
