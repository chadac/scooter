"""kanban's agent tools: read and set this conversation's card.

The card is always the calling conversation's, from the verified identity, never an
argument, so an agent can only move its own card. Setting a stage files the
conversation in that stage's folder.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

import httpx
from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult

from .boards import BoardError, Blocker, Boards, quote_blockers
from .keys import CardKeys
from .store import PRIORITIES
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


def _describe(v: dict, blockers: list[Blocker]) -> str:
    stages = ", ".join(f'"{s}"' for s in v["columns"])
    waiting = [b for b in blockers if not b.done]
    blocked = (
        f" Blocked by {quote_blockers(waiting)}: it can't move past this stage until they reach \"{v['columns'][-1]}\"."
        if waiting else ""
    )
    card = v["card"]
    if card is None:
        return (
            f'No status set yet; the card shows in "{v["column"]}". Stages: {stages}.'
            f"{blocked}{_describe_gates(v)}{_describe_tags(v)}{_describe_skills(v)}{_describe_details(v)}"
        )
    note = f' Note: "{card["note"]}".' if card["note"] else ""
    return (
        f'The card is in "{v["column"]}", last set by the {card["updated_by"]} at {card["updated_at"]}.'
        f"{note} Stages: {stages}.{blocked}{_describe_gates(v)}{_describe_tags(v)}{_describe_skills(v)}{_describe_details(v)}"
    )


def _describe_gates(v: dict) -> str:
    """What the card must pass to move on from its stage; nothing when the stage has no gates."""
    gates = v.get("gates") or []
    if not gates:
        return ""
    return f' To move on from "{v["column"]}" it must pass: {"; ".join(g["line"] for g in gates)}.'


def _describe_details(v: dict) -> str:
    """The card's priority and description; nothing for those not set."""
    d = v["details"]
    priority = f" Priority: {d['priority']}." if d["priority"] != "none" else ""
    description = f"\n\nDescription:\n{d['description']}" if d["description"] else ""
    return priority + description


def _describe_tags(v: dict) -> str:
    """The card's and board's tags; nothing when the board has none."""
    if not v["tags"]:
        return ""
    return f" Tags: {_quoted(v['card_tags']) or 'none'}. Board tags: {_quoted(v['tags'])}."


def _describe_skills(v: dict) -> str:
    """The board's skills, by the names the agent has them as; nothing when it has none."""
    skills = v.get("skills") or []
    return f" Board skills: {', '.join(f'`{s}`' for s in skills)}." if skills else ""


def _quoted(names: list[str]) -> str:
    return ", ".join(f'"{n}"' for n in names)


async def _key(ctx: ToolContext) -> str | ToolResult:
    if _boards is None:
        return ToolResult.error("kanban is not configured on this deployment.")
    key, why = await _card_key(ctx)
    return ToolResult.error(why) if key is None else key


def _names(blockers: list[Blocker]) -> str:
    return quote_blockers(blockers) if blockers else "nothing"


@mcp.tool
async def kanban_set_status(column: str, note: str = "", ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Move this conversation's card to a stage on its kanban board, with a one-line note
    on where the work stands.

    `column` is the stage's name, as kanban_get_status lists it; the user picks each
    board's stages. Call it when the work changes phase, and to confirm the status when
    asked: setting the same stage again records that it is still right. A card blocked
    by other cards can't move to a later stage until they are in the board's last stage.

    A stage may have gates the card must pass to move on from it, as kanban_get_status
    lists them: a command (e.g. the tests), which runs on your last commit just before
    this call and must pass, and the user's approval, which this call asks for. When it
    says the card is waiting for approval, end your turn; a message comes with the answer.
    """
    key = await _key(ctx)
    if isinstance(key, ToolResult):
        return key
    assert _boards is not None
    try:
        where, card = await _boards.set_stage(key, column, note=note.strip() or None)
        blockers = await _boards.blockers(key, where.conversation.owner, where.place.board)
    except BoardError as e:
        return ToolResult.error(f"{e.detail}.")
    tags = await _boards.tag_view(key, where.place.board)
    v = view(
        card, where.stages, where.stage, **tags, details=await _boards.store.details(key),
        gates=await _boards.gate_view(key, where.place.board, where.stage),
        stale_after=_stale_after, now=datetime.now(timezone.utc),
    )
    return ToolResult.ok(_describe(v, blockers))


@mcp.tool
async def kanban_get_status(ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Read this conversation's card on its kanban board: its stage, note, blockers, tags,
    priority and description, the gates it must pass to move on, and the board's stages
    and skills."""
    key = await _key(ctx)
    if isinstance(key, ToolResult):
        return key
    assert _boards is not None
    async with _boards.store.reading():
        try:
            where = await _boards.locate(key)
            blockers = await _boards.blockers(key, where.conversation.owner, where.place.board)
        except BoardError as e:
            return ToolResult.error(f"{e.detail}.")
        card = await _boards.store.card(key)
        tags = await _boards.tag_view(key, where.place.board)
        details = await _boards.store.details(key)
        skills = await _boards.store.skills(where.place.board)
        gates = await _boards.gate_view(key, where.place.board, where.stage)
    v = view(
        card, where.stages, where.stage, **tags, details=details, skills=skills, gates=gates,
        stale_after=_stale_after, now=datetime.now(timezone.utc),
    )
    return ToolResult.ok(_describe(v, blockers))


@mcp.tool
async def kanban_list_cards(ctx: ToolContext = ToolContextDep) -> ToolResult:
    """List the cards on this conversation's kanban board: each one's conversation id,
    title, stage and blockers, and the board's stages with their ids. Use the card ids
    with kanban_set_blockers, and a `stage_id` as handoff_spawn's `folder`.
    """
    key = await _key(ctx)
    if isinstance(key, ToolResult):
        return key
    assert _boards is not None
    try:
        async with _boards.store.reading():
            where = await _boards.locate(key)
            cards = await _boards.cards(where.conversation.owner, where.place.board)
    except BoardError as e:
        return ToolResult.error(f"{e.detail}.")
    for c in cards:
        c["this"] = c["id"] == where.conversation.id
    return ToolResult.ok(json.dumps({
        "stages": [{"name": s.name, "stage_id": s.folder} for s in where.stages], "cards": cards,
    }))


@mcp.tool
async def kanban_set_blockers(
    blocked_by: list[str], card: str = "", ctx: ToolContext = ToolContextDep
) -> ToolResult:
    """Set which cards block a card on this board, replacing its blockers; [] clears them.

    `card` is a conversation id from kanban_list_cards, or empty for this conversation's
    own card. A blocked card's agent can work in its current stage but can't move to a
    later one until every blocker is in the board's last stage; then it is messaged. Use
    it to order planned work, e.g. the API card blocked by the schema card.
    """
    key = await _key(ctx)
    if isinstance(key, ToolResult):
        return key
    assert _boards is not None
    try:
        where = await _boards.locate(key)
        owner, board = where.conversation.owner, where.place.board
        target = (
            await _boards.card_on(owner, board, card)
            if card.strip() else where.conversation
        )
        blockers = await _boards.set_blockers(owner, board, target, blocked_by, by="agent")
    except BoardError as e:
        return ToolResult.error(f"{e.detail}.")
    name = "This card" if target.id == where.conversation.id else f'"{target.title or target.id}"'
    return ToolResult.ok(f"{name} is now blocked by {_names(blockers)}.")


@mcp.tool
async def kanban_add_card(
    conversation: str, blocked_by: list[str] | None = None, ctx: ToolContext = ToolContextDep
) -> ToolResult:
    """Put another of the user's conversations on this board, e.g. one handoff_spawn just
    started, in the board's first stage, optionally blocked by other cards on the board.

    `conversation` is its conversation id. A conversation already on this board stays in
    its stage and only has its blockers set, if any are given.
    """
    key = await _key(ctx)
    if isinstance(key, ToolResult):
        return key
    assert _boards is not None
    try:
        conv, stage, blockers = await _boards.add_card(key, conversation, blocked_by or [])
    except BoardError as e:
        return ToolResult.error(f"{e.detail}.")
    return ToolResult.ok(
        f'"{conv.title or conv.id}" is on the board in "{stage.name}", blocked by {_names(blockers)}.'
    )


@mcp.tool
async def kanban_set_tags(tags: list[str], ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Replace this conversation's card's tags on its kanban board.

    `tags` are names from the board's tags, as kanban_get_status lists them; the user
    defines them, so you cannot add new ones. An empty list clears the card's tags.
    Tag the card once the kind of work is clear, not every run.
    """
    key = await _key(ctx)
    if isinstance(key, ToolResult):
        return key
    assert _boards is not None
    try:
        where = await _boards.set_tags(key, tags)
        blockers = await _boards.blockers(key, where.conversation.owner, where.place.board)
    except BoardError as e:
        return ToolResult.error(f"{e.detail}.")
    card = await _boards.store.card(key)
    tagged = await _boards.tag_view(key, where.place.board)
    v = view(
        card, where.stages, where.stage, **tagged, details=await _boards.store.details(key),
        stale_after=_stale_after, now=datetime.now(timezone.utc),
    )
    return ToolResult.ok(_describe(v, blockers))


@mcp.tool
async def kanban_set_details(
    description: str | None = None, priority: str | None = None, ctx: ToolContext = ToolContextDep
) -> ToolResult:
    """Set this conversation's card's description or priority on its kanban board; leave
    one out to keep it.

    `description` is markdown on what the card is for and what done looks like; write it
    once the scope is clear and edit it when the scope changes, not every run. "" clears
    it. `priority` is one of none, low, medium, high, urgent. The user may edit both.
    """
    key = await _key(ctx)
    if isinstance(key, ToolResult):
        return key
    assert _boards is not None
    if description is None and priority is None:
        return ToolResult.error(f"Give a description, a priority ({', '.join(PRIORITIES)}), or both.")
    try:
        where = await _boards.locate(key)
        details = await _boards.set_details(key, by="agent", description=description, priority=priority)
    except BoardError as e:
        return ToolResult.error(f"{e.detail}.")
    said = "a description" if details.description else "no description"
    return ToolResult.ok(f'The card in "{where.stage.name}" has priority {details.payload()["priority"]} and {said}.')


@mcp.tool
async def kanban_set_skill(name: str, body: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Write, replace or delete one of this kanban board's skills, which every card on the
    board gets as `board-<name>`.

    `name` is the skill's name, with or without `board-`; an existing skill with that name
    has its text replaced, otherwise a new one is added. `body` is the whole markdown text;
    "" deletes the skill. Use it for what every card on the board should know (conventions,
    where things live, how to ship) when the user asks or you learn something lasting, not
    for notes on this card. The user sees and edits these under Edit board. Other agents
    get the change from their next run.
    """
    key = await _key(ctx)
    if isinstance(key, ToolResult):
        return key
    assert _boards is not None
    try:
        _, slug, done = await _boards.set_skill(key, name, body)
    except BoardError as e:
        return ToolResult.error(f"{e.detail}.")
    return ToolResult.ok(f"The board skill `{slug}` was {done}.")


def kanban_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
