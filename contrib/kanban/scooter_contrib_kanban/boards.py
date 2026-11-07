"""Boards and their stages, kept in step across the router's folders and kanban's store.

The routes and the agent tools both go through here. A card's stage is the folder its
conversation is filed in; a conversation filed in the board folder itself is in the
first stage.
"""

from __future__ import annotations

from dataclasses import dataclass

from .folders import Conversation, FolderError, Folders
from .store import Card, KanbanStore, Place, Stage


class BoardError(Exception):
    """A request kanban refuses; `status` is the HTTP status the routes answer with."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _refused(e: FolderError) -> BoardError:
    # User errors pass through; router failures are ours.
    return BoardError(e.status if e.status in (400, 404, 409) else 502, e.detail)


@dataclass(frozen=True)
class Located:
    """Where a conversation's card is: its board, the board's stages, and its stage."""

    conversation: Conversation
    place: Place
    stages: list[Stage]
    stage: Stage
    folder: str


@dataclass
class Boards:
    store: KanbanStore
    folders: Folders
    # The stages a new board starts with.
    default_stages: list[str]

    async def stages(self, board: str, owner: str) -> list[Stage]:
        """A board's stages, giving one made before stages were folders its defaults."""
        stages = await self.store.stages(board)
        if stages:
            return stages
        for i, name in enumerate(self.default_stages):
            try:
                folder = await self.folders.create(owner, name, board)
            except FolderError as e:
                raise _refused(e) from None
            await self.store.add_stage(board, folder, name, float(i + 1))
        return await self.store.stages(board)

    async def list(self, owner: str) -> list[dict]:
        return [
            {"folder": b, "stages": [s.payload() for s in await self.stages(b, owner)]}
            for b in await self.store.boards(owner)
        ]

    async def own(self, owner: str, board: str) -> str:
        if board not in await self.store.boards(owner):
            raise BoardError(404, "no such board")
        return board

    async def own_stage(self, owner: str, board: str, stage: str) -> Stage:
        found = next((s for s in await self.stages(await self.own(owner, board), owner) if s.folder == stage), None)
        if found is None:
            raise BoardError(404, "no such stage")
        return found

    async def create(self, owner: str, name: str) -> str:
        try:
            board = await self.folders.create(owner, name)
        except FolderError as e:
            raise _refused(e) from None
        await self.store.add_board(owner, board)
        await self.stages(board, owner)
        return board

    async def rename(self, owner: str, board: str, name: str) -> None:
        try:
            await self.folders.update(owner, await self.own(owner, board), name=name)
        except FolderError as e:
            raise _refused(e) from None

    async def delete(self, owner: str, board: str) -> None:
        try:
            await self.folders.delete(owner, await self.own(owner, board), subfolders=True)
        except FolderError as e:
            # Already gone from the sidebar, so just forget it.
            if e.status != 404:
                raise _refused(e) from None
        await self.store.remove_board(owner, board)

    async def add_stage(self, owner: str, board: str, name: str) -> None:
        stages = await self.stages(await self.own(owner, board), owner)
        try:
            folder = await self.folders.create(owner, name, board)
        except FolderError as e:
            raise _refused(e) from None
        await self.store.add_stage(board, folder, name, (stages[-1].position if stages else 0.0) + 1)

    async def update_stage(
        self, owner: str, board: str, stage: str, *, name: str | None = None, position: float | None = None
    ) -> None:
        await self.own_stage(owner, board, stage)
        try:
            # The sidebar shows stages in the board's order.
            await self.folders.update(owner, stage, name=name, position=position)
        except FolderError as e:
            raise _refused(e) from None
        await self.store.update_stage(stage, name=name, position=position)

    async def delete_stage(self, owner: str, board: str, stage: str) -> None:
        await self.own_stage(owner, board, stage)
        if len(await self.store.stages(board)) <= 1:
            raise BoardError(409, "a board needs at least one stage")
        try:
            # Its conversations move up to the board's first stage.
            await self.folders.delete(owner, stage)
        except FolderError as e:
            if e.status != 404:
                raise _refused(e) from None
        await self.store.remove_stage(stage)

    async def at(self, folder: str) -> tuple[Place, list[Stage], Stage] | None:
        """The board, its stages and the stage a folder shows as; None off every board."""
        place = await self.store.place(folder) if folder else None
        if place is None:
            return None
        stages = await self.stages(place.board, place.owner)
        stage = next((s for s in stages if s.folder == place.stage), stages[0])
        return place, stages, stage

    async def locate(self, key: str) -> Located:
        """Where the conversation with broker key `key` is filed, as its owner sees it."""
        try:
            conv = await self.folders.conversation(key)
            folder = await self.folders.placement(conv.owner, conv.id) if conv else None
        except FolderError as e:
            raise _refused(e) from None
        if conv is None:
            raise BoardError(404, "kanban can't find this conversation")
        found = await self.at(folder or "")
        if found is None or found[0].owner != conv.owner:
            raise BoardError(409, "this conversation isn't filed on a board")
        place, stages, stage = found
        return Located(conversation=conv, place=place, stages=stages, stage=stage, folder=folder or "")

    async def set_stage(self, key: str, stage: str, *, note: str | None) -> tuple[Located, Card]:
        """The agent moves its card: file the conversation in the stage named, by name or id."""
        where = await self.locate(key)
        want = stage.strip().casefold()
        to = next((s for s in where.stages if want in (s.name.casefold(), s.folder.casefold())), None)
        if to is None:
            raise BoardError(400, f"`{stage}` is not a stage on this board")
        if to.folder != where.folder:
            try:
                await self.folders.file(where.conversation.owner, where.conversation.id, to.folder)
            except FolderError as e:
                raise _refused(e) from None
        card = await self.store.put(key, column=to.folder, by="agent", note=note)
        return Located(where.conversation, where.place, where.stages, to, to.folder), card
