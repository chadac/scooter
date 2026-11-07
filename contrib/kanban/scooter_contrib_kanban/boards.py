"""Boards and their stages, kept in step across the router's folders and kanban's store.

The routes and the agent tools both go through here. A card's stage is the folder its
conversation is filed in; a conversation filed in the board folder itself is in the
first stage.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import httpx

from .folders import Conversation, FolderError, Folders
from .messages import Send
from .store import Card, KanbanStore, Place, Stage

logger = logging.getLogger(__name__)


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


@dataclass(frozen=True)
class Blocker:
    """A card another waits on, and whether it has reached its board's last stage."""

    id: str
    title: str
    stage: str
    done: bool
    note: str = ""

    def payload(self) -> dict:
        return {"id": self.id, "title": self.title, "stage": self.stage, "done": self.done}


def quote_blockers(blockers: list[Blocker]) -> str:
    return ", ".join(f'"{b.title or b.id}" ({b.stage})' for b in blockers)


@dataclass
class Boards:
    store: KanbanStore
    folders: Folders
    # The stages a new board starts with.
    default_stages: list[str]
    # Tells a conversation its blockers are done; None sends nothing.
    send: Send | None = None

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
        """The agent moves its card: file the conversation in the stage named, by name or id.

        A blocked card can't move to a later stage; the user's moves are never gated.
        """
        where = await self.locate(key)
        want = stage.strip().casefold()
        to = next((s for s in where.stages if want in (s.name.casefold(), s.folder.casefold())), None)
        if to is None:
            raise BoardError(400, f"`{stage}` is not a stage on this board")
        owner, board, last = where.conversation.owner, where.place.board, where.stages[-1]
        if where.stages.index(to) > where.stages.index(where.stage):
            waiting = [b for b in await self.blockers(key, owner, board) if not b.done]
            if waiting:
                raise BoardError(
                    409,
                    f"this card is blocked by {quote_blockers(waiting)}, so it stays in \"{where.stage.name}\" "
                    f"or earlier until they reach \"{last.name}\". Do what you can here, then end your turn: "
                    "a message comes when they are done",
                )
        if to.folder != where.folder:
            try:
                await self.folders.file(owner, where.conversation.id, to.folder)
            except FolderError as e:
                raise _refused(e) from None
        card = await self.store.put(key, column=to.folder, by="agent", note=note)
        if to == last and where.stage != last:
            await self.release(key, owner, board)
        return Located(where.conversation, where.place, where.stages, to, to.folder), card

    async def user_move(self, key: str, owner: str, column: str, position: float | None) -> Card:
        """Record the user's move to a stage of their board; reaching the last one releases its dependents."""
        place = await self.store.place(column)
        if place is None or place.stage is None or place.owner != owner:
            raise BoardError(400, "column must be one of your boards' stage ids")
        before = await self.store.card(key)
        card = await self.store.put(key, column=column, by="user", position=position)
        stages = await self.stages(place.board, owner)
        if column == stages[-1].folder and (before is None or before.column != column):
            await self.release(key, owner, place.board)
        return card

    async def _conversation(self, ref: str) -> Conversation | None:
        try:
            return await self.folders.conversation(ref)
        except FolderError as e:
            raise _refused(e) from None

    async def _placements(self, owner: str) -> dict[str, str]:
        try:
            return await self.folders.filed(owner)
        except FolderError as e:
            raise _refused(e) from None

    async def _stage_of(self, conv: Conversation, owner: str, board: str, placements: dict[str, str]) -> Stage | None:
        """The stage `conv` shows in on `board`; None when it isn't on it."""
        if conv.owner != owner:
            return None
        found = await self.at(placements.get(conv.id) or "")
        if found is None or found[0].board != board or found[0].owner != owner:
            return None
        return found[2]

    async def blockers(
        self, key: str, owner: str, board: str, *, placements: dict[str, str] | None = None
    ) -> list[Blocker]:
        """The cards `key` waits on that are still on its board; the rest no longer block it."""
        keys = await self.store.blockers(key)
        if not keys:
            return []
        placements = await self._placements(owner) if placements is None else placements
        last = (await self.stages(board, owner))[-1]
        out: list[Blocker] = []
        for k in keys:
            conv = await self._conversation(k)
            stage = await self._stage_of(conv, owner, board, placements) if conv else None
            if conv is None or stage is None:
                continue
            card = await self.store.card(k)
            out.append(Blocker(conv.id, conv.title, stage.name, stage.folder == last.folder, card.note if card else ""))
        return out

    async def card_on(
        self, owner: str, board: str, ref: str, placements: dict[str, str] | None = None
    ) -> Conversation:
        """The conversation `ref` (its id or card key) names, if it is a card on `board`."""
        placements = await self._placements(owner) if placements is None else placements
        conv = await self._conversation(ref.strip()) if ref.strip() else None
        if conv is None or await self._stage_of(conv, owner, board, placements) is None:
            raise BoardError(404, f"`{ref}` is not a card on this board")
        return conv

    async def _waits_on(self, start: str, target: str) -> bool:
        """Whether `start` already waits on `target`, directly or through other cards."""
        seen: set[str] = set()
        todo = [start]
        while todo:
            k = todo.pop()
            if k == target:
                return True
            if k not in seen:
                seen.add(k)
                todo.extend(await self.store.blockers(k))
        return False

    async def set_blockers(
        self, owner: str, board: str, card: Conversation, refs: list[str], *, by: str
    ) -> list[Blocker]:
        """Replace `card`'s blockers with the cards `refs` names, all on `board`."""
        placements = await self._placements(owner)
        chosen: list[Conversation] = []
        for ref in refs:
            conv = await self.card_on(owner, board, ref, placements)
            if conv.key == card.key:
                raise BoardError(400, "a card can't block itself")
            if await self._waits_on(conv.key, card.key):
                raise BoardError(409, f'"{conv.title or conv.id}" already waits on this card, so it can\'t block it')
            chosen.append(conv)
        await self.store.set_blockers(card.key, [c.key for c in chosen], by=by)
        return await self.blockers(card.key, owner, board, placements=placements)

    async def add_card(self, key: str, ref: str, refs: list[str]) -> tuple[Conversation, Stage, list[Blocker]]:
        """File another of the owner's conversations on the caller's board, in its first stage unless already on it."""
        where = await self.locate(key)
        owner, board = where.conversation.owner, where.place.board
        conv = await self._conversation(ref.strip()) if ref.strip() else None
        if conv is None or conv.owner != owner:
            raise BoardError(404, f"`{ref}` isn't a conversation of this board's owner")
        placements = await self._placements(owner)
        stage = await self._stage_of(conv, owner, board, placements)
        if stage is None:
            if await self.at(placements.get(conv.id) or ""):
                raise BoardError(409, "that conversation is on another board")
            stage = where.stages[0]
            try:
                await self.folders.file(owner, conv.id, stage.folder)
            except FolderError as e:
                raise _refused(e) from None
        blockers = (
            await self.set_blockers(owner, board, conv, refs, by="agent")
            if refs else await self.blockers(conv.key, owner, board)
        )
        return conv, stage, blockers

    async def cards(self, owner: str, board: str) -> list[dict]:
        """Every card on `board`, in stage order, with its blockers."""
        placements = await self._placements(owner)
        stages = await self.stages(board, owner)
        at = {s.folder: i for i, s in enumerate(stages)} | {board: 0}
        out: list[tuple[int, dict]] = []
        for conv_id, folder in placements.items():
            if folder not in at:
                continue
            conv = await self._conversation(conv_id)
            if conv is None or conv.owner != owner:
                continue
            blockers = await self.blockers(conv.key, owner, board, placements=placements)
            out.append((at[folder], {
                "id": conv.id, "title": conv.title, "stage": stages[at[folder]].name,
                "blocked_by": [b.payload() for b in blockers],
            }))
        return [c for _, c in sorted(out, key=lambda t: t[0])]

    async def release(self, key: str, owner: str, board: str) -> list[str]:
        """Message each card whose last open blocker `key` was; returns their conversation ids.

        A failure here is logged, never raised: the move it follows has already happened.
        """
        if self.send is None:
            return []
        told: list[str] = []
        try:
            placements = await self._placements(owner)
            for dep in await self.store.dependents(key):
                conv = await self._conversation(dep)
                if conv is None or await self._stage_of(conv, owner, board, placements) is None:
                    continue
                blockers = await self.blockers(dep, owner, board, placements=placements)
                if not blockers or not all(b.done for b in blockers):
                    continue
                done = ", ".join(
                    f'"{b.title or b.id}"' + (f' (note: "{b.note}")' if b.note else "") for b in blockers
                )
                text = (
                    f"The cards blocking this one on the kanban board are done: {done}. "
                    "You can move this card on to its next stage now."
                )
                try:
                    await self.send(conv.id, text)
                    told.append(conv.id)
                except httpx.HTTPError as e:
                    logger.warning("kanban unblock message failed", extra={"conversation_id": conv.id, "error": str(e)})
        except BoardError as e:
            logger.warning("kanban could not release dependents", extra={"card": key, "error": e.detail})
        return told

    async def blockers_of(self, key: str, owner: str) -> list[Blocker]:
        """`key`'s blockers on whatever board `owner` filed it on; [] off every board."""
        if not await self.store.blockers(key):
            return []
        conv = await self._conversation(key)
        if conv is None or conv.owner != owner:
            return []
        placements = await self._placements(owner)
        found = await self.at(placements.get(conv.id) or "")
        if found is None or found[0].owner != owner:
            return []
        return await self.blockers(key, owner, found[0].board, placements=placements)

