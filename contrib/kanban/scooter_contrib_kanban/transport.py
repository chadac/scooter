"""kanban's HTTP routes, mounted under /kanban/*.

    GET  /card?folder=<id>             this conversation's card, and whether the folder is a board (hooks)
    GET  /user/boards                  the user's boards and the columns (the view, via /contrib-api)
    PUT  /user/boards/{folder}         opt a folder in as a board
    DELETE /user/boards/{folder}       opt it out again
    GET  /conversation/{key}/card      one card (the board, via the conversation relay)
    PUT  /conversation/{key}/card      {column, position?}: the user moves a card

/user/* and /conversation/* are reached only through the agent-host's relays, which
name the user and have already checked they may see the conversation.
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

from .config import Column
from .store import Card, KanbanStore

# Folder ids are URL-safe: router UUIDs, or ids a folder service chose.
_FOLDER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def is_stale(card: Card | None, stale_after: timedelta, now: datetime) -> bool:
    """Whether the card was never set, or not touched within `stale_after`."""
    if card is None:
        return True
    try:
        at = datetime.fromisoformat(card.updated_at)
    except ValueError:
        return True
    return now - at > stale_after


def view(card: Card | None, columns: list[Column], *, stale_after: timedelta, now: datetime) -> dict:
    """A card as every route returns it; no row means the first column."""
    return {
        "card": card.payload() if card else None,
        "column": card.column if card else columns[0].id,
        "columns": [{"id": c.id, "label": c.label} for c in columns],
        "stale": is_stale(card, stale_after, now),
    }


@dataclass
class Kanban(Transport):
    name: str = "kanban"
    store: KanbanStore | None = None
    columns: list[Column] = field(default_factory=list)
    stale_after: timedelta = timedelta(minutes=30)
    # The relayed user; None means user_identity(authed). Tests may inject a fake.
    user: Callable[..., Awaitable[str]] | None = None
    now: Callable[[], datetime] = field(default=lambda: datetime.now(timezone.utc))

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter(tags=["kanban"])

        def _store() -> KanbanStore:
            if self.store is None:
                raise HTTPException(status_code=503, detail="kanban not configured")
            return self.store

        async def _view(key: str) -> dict:
            card = await _store().card(key)
            return view(card, self.columns, stale_after=self.stale_after, now=self.now())

        user = Depends(self.user or user_identity(authed))

        def _folder(folder: str) -> str:
            if not _FOLDER.match(folder):
                raise HTTPException(status_code=400, detail="folder must be a folder id")
            return folder

        @router.get("/card")
        async def own_card(folder: str = "", identity: Identity = Depends(authed)) -> dict:
            if not identity.conversation_id:
                raise HTTPException(status_code=403, detail="a conversation identity is required")
            board = bool(folder) and await _store().is_board(_folder(folder))
            return {**await _view(identity.conversation_id), "board": board}

        async def _boards(owner: str) -> dict:
            return {
                "boards": await _store().boards(owner),
                "columns": [{"id": c.id, "label": c.label} for c in self.columns],
            }

        @router.get("/user/boards")
        async def boards(owner: str = user) -> dict:
            return await _boards(owner)

        @router.put("/user/boards/{folder}")
        async def add_board(folder: str, owner: str = user) -> dict:
            await _store().add_board(owner, _folder(folder))
            return await _boards(owner)

        @router.delete("/user/boards/{folder}")
        async def remove_board(folder: str, owner: str = user) -> dict:
            await _store().remove_board(owner, _folder(folder))
            return await _boards(owner)

        @router.get("/conversation/{key}/card")
        async def get_card(key: str, _user: str = user) -> dict:
            return await _view(key)

        @router.put("/conversation/{key}/card")
        async def move_card(key: str, body: dict = Body(...), _user: str = user) -> dict:
            column = body.get("column")
            if column not in {c.id for c in self.columns}:
                raise HTTPException(status_code=400, detail="column must be one of the board's column ids")
            position = body.get("position")
            if position is not None and (
                isinstance(position, bool) or not isinstance(position, (int, float)) or not math.isfinite(position)
            ):
                raise HTTPException(status_code=400, detail="position must be a finite number")
            await _store().put(key, column=column, by="user", position=position)
            return await _view(key)

        return router
