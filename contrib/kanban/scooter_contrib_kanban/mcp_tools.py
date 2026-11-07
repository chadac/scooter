"""kanban's agent tools: read and set this conversation's card.

The card is always the calling conversation's, from the verified identity, never an
argument, so an agent can only move its own card. Setting a stage files the
conversation in that stage's folder.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

import httpx
from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult

from .boards import BoardError, Boards
from .keys import CardKeys
from .transport import view

logger = logging.getLogger(__name__)

mcp = FastMCP(name="kanban")

# Set by the provider factory.
_boards: Boards | None = None
_stale_after = timedelta(minutes=30)
_keys: CardKeys | None = None


def configure(boards: Boards | None, stale_after: timedelta, keys: CardKeys | None) -> None:
    global _boards, _stale_after, _keys
    _boards, _stale_after, _keys = boards, stale_after, keys


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


def _describe(v: dict) -> str:
    stages = ", ".join(f'"{s}"' for s in v["columns"])
    card = v["card"]
    if card is None:
        return f'No status set yet; the card shows in "{v["column"]}". Stages: {stages}.'
    note = f' Note: "{card["note"]}".' if card["note"] else ""
    return (
        f'The card is in "{v["column"]}", last set by the {card["updated_by"]} at {card["updated_at"]}.'
        f"{note} Stages: {stages}."
    )


async def _key(ctx: ToolContext) -> str | ToolResult:
    if _boards is None:
        return ToolResult.error("kanban is not configured on this deployment.")
    key, why = await _card_key(ctx)
    return ToolResult.error(why) if key is None else key


@mcp.tool
async def kanban_set_status(column: str, note: str = "", ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Move this conversation's card to a stage on its kanban board, with a one-line note
    on where the work stands.

    `column` is the stage's name, as kanban_get_status lists it; the user picks each
    board's stages. Call it when the work changes phase, and to confirm the status when
    asked: setting the same stage again records that it is still right.
    """
    key = await _key(ctx)
    if isinstance(key, ToolResult):
        return key
    assert _boards is not None
    try:
        where, card = await _boards.set_stage(key, column, note=note.strip() or None)
    except BoardError as e:
        return ToolResult.error(f"{e.detail}.")
    v = view(card, where.stages, where.stage, stale_after=_stale_after, now=datetime.now(timezone.utc))
    return ToolResult.ok(_describe(v))


@mcp.tool
async def kanban_get_status(ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Read this conversation's stage and note on its kanban board, and the board's stages."""
    key = await _key(ctx)
    if isinstance(key, ToolResult):
        return key
    assert _boards is not None
    try:
        where = await _boards.locate(key)
    except BoardError as e:
        return ToolResult.error(f"{e.detail}.")
    card = await _boards.store.card(key)
    v = view(card, where.stages, where.stage, stale_after=_stale_after, now=datetime.now(timezone.utc))
    return ToolResult.ok(_describe(v))


def kanban_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
