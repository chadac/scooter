"""kanban's HTTP routes, mounted under /kanban/*.

    GET    /card?folder=<id>&since=<t>             this conversation's card and stage, if the folder is on a board (hooks)
    GET    /user/boards                            the user's boards and their stages (the view, via /contrib-api)
    POST   /user/boards                            {name}: a new board, with the default stages
    PATCH  /user/boards/{board}                    {name}: rename a board
    DELETE /user/boards/{board}                    delete a board and its stages; its conversations stay, unfiled
    POST   /user/boards/{board}/stages             {name}: add a stage at the end
    PATCH  /user/boards/{board}/stages/{stage}     {name?, position?}: rename or reorder a stage
    DELETE /user/boards/{board}/stages/{stage}     delete a stage; its cards move to the first stage
    GET    /conversation/{key}/card                one card and its blockers (the board, via the conversation relay)
    PUT    /conversation/{key}/card                {column, position?}: record the user's move to a stage

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

from .boards import BoardError, Blocker, Boards
from .store import Card, KanbanStore, Stage

# Folder ids are URL-safe: router UUIDs, or ids a folder service chose.
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
    stale_after: timedelta,
    now: datetime,
    since: datetime | None = None,
    blockers: list[Blocker] | None = None,
) -> dict:
    """A card on a board, as the hooks and the agent tools read it."""
    return {
        "board": True,
        "card": card.payload() if card else None,
        "column": stage.name,
        "columns": [s.name for s in stages],
        # Open blockers only: they hold the card in its stage.
        "blocked_by": [b.payload() for b in blockers or [] if not b.done],
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

        def _position(body: dict) -> float | None:
            position = body.get("position")
            if position is not None and (
                isinstance(position, bool) or not isinstance(position, (int, float)) or not math.isfinite(position)
            ):
                raise HTTPException(status_code=400, detail="position must be a finite number")
            return None if position is None else float(position)

        async def _list(owner: str, **extra: str) -> dict:
            try:
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
            if not identity.conversation_id:
                raise HTTPException(status_code=403, detail="a conversation identity is required")
            card = await _store().card(identity.conversation_id)
            try:
                found = await _boards().at(_folder(folder)) if folder else None
            except BoardError as e:
                raise _http(e) from None
            if found is None:
                return {"board": False, "card": card.payload() if card else None}
            place, stages, stage = found
            try:
                blockers = await _boards().blockers(identity.conversation_id, place.owner, place.board)
            except BoardError as e:
                raise _http(e) from None
            return view(
                card, stages, stage, stale_after=self.stale_after, now=self.now(), since=_since(since), blockers=blockers
            )

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

        @router.delete("/user/boards/{board}")
        async def delete_board(board: str, owner: str = user) -> dict:
            await _do(_boards().delete(owner, _folder(board)))
            return await _list(owner)

        @router.post("/user/boards/{board}/stages")
        async def add_stage(board: str, body: dict = Body(...), owner: str = user) -> dict:
            await _do(_boards().add_stage(owner, _folder(board), _name(body)))
            return await _list(owner)

        @router.patch("/user/boards/{board}/stages/{stage}")
        async def update_stage(board: str, stage: str, body: dict = Body(...), owner: str = user) -> dict:
            name = _name(body) if "name" in body else None
            position = _position(body)
            if name is None and position is None:
                raise HTTPException(status_code=400, detail="name or position is required")
            await _do(_boards().update_stage(owner, _folder(board), _folder(stage), name=name, position=position))
            return await _list(owner)

        @router.delete("/user/boards/{board}/stages/{stage}")
        async def delete_stage(board: str, stage: str, owner: str = user) -> dict:
            await _do(_boards().delete_stage(owner, _folder(board), _folder(stage)))
            return await _list(owner)

        @router.get("/conversation/{key}/card")
        async def get_card(key: str, owner: str = user) -> dict:
            card = await _store().card(key)
            try:
                blockers = await _boards().blockers_of(key, owner)
            except BoardError as e:
                raise _http(e) from None
            return {"card": card.payload() if card else None, "blockers": [b.payload() for b in blockers]}

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


        return router
