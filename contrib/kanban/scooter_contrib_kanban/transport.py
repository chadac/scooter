"""kanban's HTTP routes, mounted under /kanban/*.

    GET    /card?folder=<id>&since=<t>             this conversation's card and stage, if the folder is on a board (hooks)
    GET    /skills                                 the skills of this conversation's board, as a skill provider prints them
    GET    /user/boards                            the user's boards and their stages (the view, via /contrib-api)
    POST   /user/boards                            {name}: a new board, with the default stages
    PATCH  /user/boards/{board}                    {name}: rename a board
    PUT    /user/boards/{board}                    {stages: [{id?, name}], tags: [{id?, name, color?}], skills?: [{id?, name, body}]}: save the board's stages, tags and skills at once; a dropped stage's cards move to the first
    DELETE /user/boards/{board}                    delete a board and its stages; its conversations stay, unfiled
    POST   /user/boards/{board}/cards              {conversations}: those cards on the board, as GET /conversation/{key}/card shows one
    GET    /conversation/{key}/card                one card, its blockers, tag ids and priority (the board, via the conversation relay)
    PUT    /conversation/{key}/card                {column, position?}: record the user's move to a stage
    PUT    /conversation/{key}/card/tags           {tags: [id], board?, create?: [name]}: the user replaces the card's tags, making new ones
    PUT    /conversation/{key}/card/blockers       {blocked_by: [conversation id]}: the user replaces the card's blockers
    GET    /conversation/{key}/details             the card's description, priority, blockers and the cards it blocks
    PATCH  /conversation/{key}/details             {description?, priority?}: the user edits them

/user/* and /conversation/* are reached only through the agent-host's relays, which
name the user and have already checked they may see the conversation. Every board
and stage is a locked folder; moving a card files its conversation in the stage's
folder, which the board does itself before it records the move here.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable

from fastapi import APIRouter, Body, Depends, HTTPException

from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport
from scooter_broker_lib.user import user_identity

from .boards import MAX_READ_CARDS, BoardError, Blocker, Boards, skill_file, skill_slug
from .store import Card, Details, KanbanStore, Skill, Stage, Tag

# Folder and tag ids are URL-safe: UUIDs, or ids a folder service chose.
_FOLDER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def is_stale(card: Card | None, stale_after: timedelta, now: datetime, since: datetime | None = None) -> bool:
    """Whether the agent owes a status: none set, the user's move unconfirmed, or none this run.

    `since` is when the run started; without it, an update older than `stale_after` is stale.
    """
    if card is None or card.updated_by != "agent":
        return True
    try:
        at = datetime.fromisoformat(card.updated_at)
    except ValueError:
        return True
    return at < since if since is not None else now - at > stale_after


def view(
    card: Card | None,
    stages: list[Stage],
    stage: Stage,
    *,
    tags: list[Tag],
    card_tags: list[Tag],
    stale_after: timedelta,
    now: datetime,
    since: datetime | None = None,
    blockers: list[Blocker] | None = None,
    details: Details | None = None,
    skills: list[Skill] | None = None,
) -> dict:
    """A card on a board, as the hooks and the agent tools read it."""
    return {
        "board": True,
        "card": card.payload() if card else None,
        "column": stage.name,
        "columns": [s.name for s in stages],
        # Open blockers only: they hold the card in its stage.
        "blocked_by": [b.payload() for b in blockers or [] if not b.done],
        "tags": [t.name for t in tags],
        "card_tags": [t.name for t in card_tags],
        "details": (details or Details()).payload(),
        # The agent's names for the board's skills, which the skill provider offers it.
        "skills": [skill_slug(k.name) for k in skills or []],
        "stale": is_stale(card, stale_after, now, since),
        # The broker's clock, so a hook marks a run's start without trusting its own.
        "now": now.isoformat(),
    }


def _http(e: BoardError) -> HTTPException:
    return HTTPException(status_code=e.status, detail=e.detail)


@dataclass
class Kanban(Transport):
    name: str = "kanban"
    boards: Boards | None = None
    stale_after: timedelta = timedelta(minutes=30)
    # The relayed user; None means user_identity(authed). Tests may inject a fake.
    user: Callable[..., Awaitable[str]] | None = None
    now: Callable[[], datetime] = field(default=lambda: datetime.now(timezone.utc))

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter(tags=["kanban"])

        def _boards() -> Boards:
            if self.boards is None:
                raise HTTPException(status_code=503, detail="kanban not configured")
            return self.boards

        def _store() -> KanbanStore:
            return _boards().store

        user = Depends(self.user or user_identity(authed))

        def _since(since: str) -> datetime | None:
            if not since:
                return None
            try:
                at = datetime.fromisoformat(since)
            except ValueError:
                raise HTTPException(status_code=400, detail="since must be an ISO 8601 time") from None
            if at.tzinfo is None:
                raise HTTPException(status_code=400, detail="since must carry a UTC offset")
            return at

        def _folder(folder: str) -> str:
            if not _FOLDER.match(folder):
                raise HTTPException(status_code=400, detail="folder must be a folder id")
            return folder

        def _name(body: dict) -> str:
            name = body.get("name")
            if not isinstance(name, str) or not name.strip():
                raise HTTPException(status_code=400, detail="name is required")
            return name.strip()

        def _color(body: dict) -> str | None:
            color = body.get("color")
            if color is not None and not isinstance(color, str):
                raise HTTPException(status_code=400, detail="color must be a string")
            return color

        def _position(body: dict) -> float | None:
            position = body.get("position")
            if position is not None and (
                isinstance(position, bool) or not isinstance(position, (int, float)) or not math.isfinite(position)
            ):
                raise HTTPException(status_code=400, detail="position must be a finite number")
            return None if position is None else float(position)

        async def _list(owner: str, **extra: str) -> dict:
            try:
                async with _store().reading():
                    return {"boards": await _boards().list(owner), **extra}
            except BoardError as e:
                raise _http(e) from None

        async def _do(work: Awaitable[object]) -> None:
            try:
                await work
            except BoardError as e:
                raise _http(e) from None

        @router.get("/card")
        async def own_card(folder: str = "", since: str = "", identity: Identity = Depends(authed)) -> dict:
            key = identity.conversation_id
            if not key:
                raise HTTPException(status_code=403, detail="a conversation identity is required")
            async with _store().reading():
                card = await _store().card(key)
                try:
                    found = await _boards().at(_folder(folder)) if folder else None
                except BoardError as e:
                    raise _http(e) from None
                if found is None:
                    return {"board": False, "card": card.payload() if card else None}
                place, stages, stage = found
                try:
                    blockers = await _boards().blockers(key, place.owner, place.board)
                except BoardError as e:
                    raise _http(e) from None
                tags = await _boards().tag_view(key, place.board)
                details = await _store().details(key)
                skills = await _store().skills(place.board)
            return view(
                card,
                stages,
                stage,
                **tags,
                stale_after=self.stale_after,
                now=self.now(),
                since=_since(since),
                blockers=blockers,
                details=details,
                skills=skills,
            )

        @router.get("/skills")
        async def own_skills(identity: Identity = Depends(authed)) -> dict:
            """The kanban skill provider's answer: none off a board."""
            key = identity.conversation_id
            if not key:
                raise HTTPException(status_code=403, detail="a conversation identity is required")
            try:
                async with _store().reading():
                    where = await _boards().locate(key)
                    skills = await _store().skills(where.place.board)
            except BoardError as e:
                if e.status in (404, 409):
                    return {"skills": []}
                raise _http(e) from None
            return {"skills": [skill_file(k) for k in skills]}

        @router.get("/user/boards")
        async def list_boards(owner: str = user) -> dict:
            return await _list(owner)

        @router.post("/user/boards")
        async def create_board(body: dict = Body(...), owner: str = user) -> dict:
            name = _name(body)
            try:
                board = await _boards().create(owner, name)
            except BoardError as e:
                raise _http(e) from None
            return await _list(owner, folder=board)

        @router.patch("/user/boards/{board}")
        async def rename_board(board: str, body: dict = Body(...), owner: str = user) -> dict:
            await _do(_boards().rename(owner, _folder(board), _name(body)))
            return await _list(owner)

        def _items(body: dict, key: str) -> list[dict]:
            items = body.get(key)
            if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
                raise HTTPException(status_code=400, detail=f"{key} must be a list of objects")
            for i in items:
                if not isinstance(i.get("name"), str) or not isinstance(i.get("id", ""), str):
                    raise HTTPException(status_code=400, detail=f"each of {key} needs a name, and an id if it isn't new")
                if i.get("id") and not _FOLDER.match(i["id"]):
                    raise HTTPException(status_code=400, detail=f"{key} ids must be ids")
            return items

        @router.put("/user/boards/{board}")
        async def save_board(board: str, body: dict = Body(...), owner: str = user) -> dict:
            stages = [Stage(s.get("id", ""), s["name"], 0.0) for s in _items(body, "stages")]
            tags = [Tag(t.get("id", ""), t["name"], _color(t) or "", 0.0) for t in _items(body, "tags")]
            skills = None
            if "skills" in body:
                items = _items(body, "skills")
                if not all(isinstance(k.get("body"), str) for k in items):
                    raise HTTPException(status_code=400, detail="each skill needs a body")
                skills = [Skill(k.get("id", ""), k["name"], k["body"], 0.0) for k in items]
            try:
                return {"board": await _boards().save(owner, _folder(board), stages, tags, skills)}
            except BoardError as e:
                raise _http(e) from None

        @router.delete("/user/boards/{board}")
        async def delete_board(board: str, owner: str = user) -> dict:
            await _do(_boards().delete(owner, _folder(board)))
            return await _list(owner)

        @router.post("/user/boards/{board}/cards")
        async def board_cards(board: str, body: dict = Body(...), owner: str = user) -> dict:
            ids = body.get("conversations")
            if not isinstance(ids, list) or not all(isinstance(i, str) and i for i in ids):
                raise HTTPException(status_code=400, detail="conversations must be a list of conversation ids")
            if len(ids) > MAX_READ_CARDS:
                raise HTTPException(status_code=400, detail=f"ask for at most {MAX_READ_CARDS} cards at once")
            try:
                async with _store().reading():
                    return {"cards": await _boards().board_cards(owner, _folder(board), ids)}
            except BoardError as e:
                raise _http(e) from None

        @router.get("/conversation/{key}/card")
        async def get_card(key: str, owner: str = user) -> dict:
            async with _store().reading():
                card = await _store().card(key)
                try:
                    blockers = await _boards().blockers_of(key, owner)
                except BoardError as e:
                    raise _http(e) from None
                tags = await _store().card_tags(key)
                details = await _store().details(key)
            return {
                "card": card.payload() if card else None,
                "blockers": [b.payload() for b in blockers],
                "tags": tags,
                "priority": details.payload()["priority"],
            }

        @router.put("/conversation/{key}/card")
        async def move_card(key: str, body: dict = Body(...), owner: str = user) -> dict:
            column = body.get("column")
            if not isinstance(column, str) or not _FOLDER.match(column):
                raise HTTPException(status_code=400, detail="column must be one of your boards' stage ids")
            position = _position(body)
            try:
                card = await _boards().user_move(key, owner, column, position)
            except BoardError as e:
                raise _http(e) from None
            return {"card": card.payload()}

        @router.put("/conversation/{key}/card/tags")
        async def tag_card(key: str, body: dict = Body(...), owner: str = user) -> dict:
            tags, board, create = body.get("tags"), body.get("board", ""), body.get("create", [])
            if not isinstance(tags, list) or not all(isinstance(t, str) for t in tags):
                raise HTTPException(status_code=400, detail="tags must be a list of tag ids")
            if not isinstance(create, list) or not all(isinstance(n, str) for n in create):
                raise HTTPException(status_code=400, detail="create must be a list of tag names")
            if not isinstance(board, str):
                raise HTTPException(status_code=400, detail="board must be a board id")
            try:
                ids, made = await _boards().tag_card(owner, key, tags, board=board and _folder(board), create=create)
            except BoardError as e:
                raise _http(e) from None
            return {"tags": ids, "created": [t.payload() for t in made]}

        @router.put("/conversation/{key}/card/blockers")
        async def block_card(key: str, body: dict = Body(...), owner: str = user) -> dict:
            refs = body.get("blocked_by")
            if not isinstance(refs, list) or not all(isinstance(r, str) for r in refs):
                raise HTTPException(status_code=400, detail="blocked_by must be a list of conversation ids")
            try:
                blockers = await _boards().user_set_blockers(owner, key, refs)
            except BoardError as e:
                raise _http(e) from None
            return {"blockers": [b.payload() for b in blockers]}

        async def _details(key: str, owner: str) -> dict:
            async with _store().reading():
                try:
                    blocked_by = await _boards().blockers_of(key, owner)
                    blocking = await _boards().dependents_of(key, owner)
                except BoardError as e:
                    raise _http(e) from None
                details = await _store().details(key)
            return {
                **details.payload(),
                "blocked_by": [b.payload() for b in blocked_by],
                "blocking": [b.payload() for b in blocking],
            }

        @router.get("/conversation/{key}/details")
        async def get_details(key: str, owner: str = user) -> dict:
            return await _details(key, owner)

        @router.patch("/conversation/{key}/details")
        async def edit_details(key: str, body: dict = Body(...), owner: str = user) -> dict:
            description, priority = body.get("description"), body.get("priority")
            if description is not None and not isinstance(description, str):
                raise HTTPException(status_code=400, detail="description must be a string")
            if priority is not None and not isinstance(priority, str):
                raise HTTPException(status_code=400, detail="priority must be a string")
            if description is None and priority is None:
                raise HTTPException(status_code=400, detail="description or priority is required")
            await _do(_boards().set_details(key, by="user", description=description, priority=priority, owner=owner))
            return await _details(key, owner)

        return router
