"""Boards and their stages, kept in step across the router's folders and kanban's store.

The routes and the agent tools both go through here. A card's stage is the folder its
conversation is filed in; a conversation filed in the board folder itself is in the
first stage.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, replace

import httpx

from .folders import Conversation, FolderError, Folders
from .messages import Send
from .store import PRIORITIES, Card, Details, KanbanStore, Place, Stage, Tag

MAX_TAG_CHARS = 24
MAX_BOARD_TAGS = 20
MAX_CARD_TAGS = 5
# Palette keys; the board maps each to its own classes.
TAG_COLORS = ("gray", "red", "orange", "yellow", "green", "teal", "blue", "purple")
# Router lookups a board load runs at once.
MAX_LOOKUPS = 8
# The most cards one board read may ask for.
MAX_READ_CARDS = 200
# More card ids than this push as none, meaning any.
MAX_PUSH_IDS = 100

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


def parse_priority(name: str) -> int:
    """A priority's stored number, from its name, e.g. "high"."""
    want = name.strip().casefold()
    if want not in PRIORITIES:
        raise BoardError(400, f"priority must be one of {', '.join(PRIORITIES)}")
    return PRIORITIES.index(want)


def quote_blockers(blockers: list[Blocker]) -> str:
    return ", ".join(f'"{b.title or b.id}" ({b.stage})' for b in blockers)


def positions(old: list[float | None]) -> list[float]:
    """Positions for items in this order, keeping the most old ones that stay in order.

    `old` is each item's current position, None for a new one. Keeping positions spares
    a router call per stage that didn't move.
    """
    n = len(old)
    # Longest strictly increasing run of old positions.
    best, prev = [0] * n, [-1] * n
    for i, p in enumerate(old):
        if p is None:
            continue
        best[i] = 1
        for j in range(i):
            q = old[j]
            if q is not None and q < p and best[j] + 1 > best[i]:
                best[i], prev[i] = best[j] + 1, j
    out: list[float | None] = [None] * n
    i = max(range(n), key=lambda k: best[k], default=-1)
    while i >= 0 and best[i]:
        out[i] = old[i]
        i = prev[i]
    # Spread the rest evenly between their kept neighbours.
    i = 0
    while i < n:
        if out[i] is not None:
            i += 1
            continue
        j = i
        while j < n and out[j] is None:
            j += 1
        lo, hi, k = out[i - 1] if i else None, out[j] if j < n else None, j - i
        for x in range(k):
            if lo is None and hi is None:
                out[i + x] = float(x + 1)
            elif lo is None:
                out[i + x] = hi - (k - x)
            elif hi is None:
                out[i + x] = lo + x + 1
            else:
                out[i + x] = lo + (hi - lo) * (x + 1) / (k + 1)
        i = j
    return [p for p in out if p is not None]


def _pick_color(used: list[str]) -> str:
    # The first palette color no tag has yet, cycling once all are used.
    return min(TAG_COLORS, key=lambda c: (used.count(c), TAG_COLORS.index(c)))


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

    async def changed(self, owner: str, *conversations: str) -> None:
        """Tell `owner`'s open boards; never raises, and no ids means anything."""
        ids = list(dict.fromkeys(c for c in conversations if c))
        try:
            await self.folders.changed(owner, ids if len(ids) <= MAX_PUSH_IDS else [])
        except FolderError as e:
            logger.warning("kanban change push failed", extra={"status": e.status, "error": e.detail})

    async def changed_card(self, key: str, owner: str = "") -> None:
        """`changed` for a card known only by its key."""
        try:
            conv = await self.folders.conversation(key)
        except FolderError as e:
            logger.warning("kanban change push failed", extra={"status": e.status, "error": e.detail})
            return
        if conv is not None:
            await self.changed(owner or conv.owner, conv.id)

    async def list(self, owner: str, board: str | None = None) -> list[dict]:
        """`owner`'s boards with their stages and tags; only `board` when given."""
        return [
            {
                "folder": b,
                "stages": [s.payload() for s in stages or await self.stages(b, owner)],
                "tags": [t.payload() for t in tags],
            }
            for b, stages, tags in await self.store.layout(owner, board)
        ]

    async def own(self, owner: str, board: str) -> str:
        if await self.store.board_owner(board) != owner:
            raise BoardError(404, "no such board")
        return board

    async def save(self, owner: str, board: str, stages: list[Stage], tags: list[Tag]) -> dict:
        """Make a board's stages and tags these, in this order; returns the board as `list` shows it.

        An item with an empty id is new, a listed one keeps its id, and the rest are deleted.
        Stage folders change first, as the router can't share kanban's transaction; what they
        refuse is left as it was, and the store records what happened before the error is raised.
        """
        have = {s.folder: s for s in await self.stages(await self.own(owner, board), owner)}
        old_tags = {t.id: t for t in await self.store.tags(board)}
        stages, tags = self._check(stages, tags, have, old_tags)
        at = positions([have[s.folder].position if s.folder else None for s in stages])

        async def put(s: Stage, position: float) -> tuple[Stage | None, FolderError | None]:
            """The stage as the router now has it, and what it refused."""
            old = have.get(s.folder)
            try:
                folder = s.folder or await self.folders.create(owner, s.name, board)
            except FolderError as e:
                return None, e
            name = None if old and old.name == s.name else s.name
            moved = None if old and old.position == position else position
            try:
                if name is not None or moved is not None:
                    # The sidebar shows stages in the board's order.
                    await self.folders.update(owner, folder, name=name, position=moved)
            except FolderError as e:
                # The new folder exists even though the update failed.
                return old or Stage(folder, s.name, position), e
            return Stage(folder, s.name, position), None

        async def drop(stage: Stage) -> tuple[Stage | None, FolderError | None]:
            try:
                # Its conversations move up to the board's first stage.
                await self.folders.delete(owner, stage.folder)
            except FolderError as e:
                if e.status != 404:
                    return stage, e
            return None, None

        keep = {s.folder for s in stages}
        done = await asyncio.gather(
            *(put(s, p) for s, p in zip(stages, at)), *(drop(s) for f, s in have.items() if f not in keep)
        )
        outcome = sorted((st for st, _ in done if st is not None), key=lambda st: st.position)
        tag_at = positions([old_tags[t.id].position if t.id else None for t in tags])
        await self.store.save_board(board, outcome, [replace(t, position=p) for t, p in zip(tags, tag_at)])
        await self.changed(owner)
        failed = next((e for _, e in done if e is not None), None)
        if failed is not None:
            raise _refused(failed)
        return (await self.list(owner, board))[0]

    def _check(
        self, stages: list[Stage], tags: list[Tag], have: dict[str, Stage], old_tags: dict[str, Tag]
    ) -> tuple[list[Stage], list[Tag]]:
        """The stages and tags a save asks for, cleaned up, or the BoardError refusing them."""
        if not stages:
            raise BoardError(409, "a board needs at least one stage")
        ids = [s.folder for s in stages if s.folder]
        if any(i not in have for i in ids) or len(set(ids)) != len(ids):
            raise BoardError(400, "stages must be new or this board's, each once")
        out_stages = []
        for s in stages:
            name = s.name.strip()
            if not name:
                raise BoardError(400, "a stage needs a name")
            out_stages.append(replace(s, name=name))
        if len(tags) > MAX_BOARD_TAGS:
            raise BoardError(409, f"a board has at most {MAX_BOARD_TAGS} tags")
        ids = [t.id for t in tags if t.id]
        if any(i not in old_tags for i in ids) or len(set(ids)) != len(ids):
            raise BoardError(400, "tags must be new or this board's, each once")
        out_tags: list[Tag] = []
        seen: set[str] = set()
        for t in tags:
            name = t.name.strip()
            if not name:
                raise BoardError(400, "a tag needs a name")
            if len(name) > MAX_TAG_CHARS:
                raise BoardError(400, f"a tag name is at most {MAX_TAG_CHARS} characters")
            if name.casefold() in seen:
                raise BoardError(409, f"this board already has a tag named `{name}`")
            seen.add(name.casefold())
            color = t.color or (old_tags[t.id].color if t.id else _pick_color([x.color for x in out_tags]))
            out_tags.append(replace(t, name=name, color=self._color(color)))
        return out_stages, out_tags

    async def create(self, owner: str, name: str) -> str:
        try:
            board = await self.folders.create(owner, name)
        except FolderError as e:
            raise _refused(e) from None
        await self.store.add_board(owner, board)
        await self.stages(board, owner)
        await self.changed(owner)
        return board

    async def rename(self, owner: str, board: str, name: str) -> None:
        try:
            await self.folders.update(owner, await self.own(owner, board), name=name)
        except FolderError as e:
            raise _refused(e) from None
        await self.changed(owner)

    async def delete(self, owner: str, board: str) -> None:
        try:
            await self.folders.delete(owner, await self.own(owner, board), subfolders=True)
        except FolderError as e:
            # Already gone from the sidebar, so just forget it.
            if e.status != 404:
                raise _refused(e) from None
        await self.store.remove_board(owner, board)
        await self.changed(owner)

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
        await self.changed(owner, where.conversation.id)
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
        await self.changed_card(key, owner)
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
        await self.changed(owner, card.id)
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

    async def board_cards(self, owner: str, board: str, conversations: list[str]) -> dict[str, dict]:
        """The cards of `conversations` on `board`, by conversation id, in one read."""
        stages = await self.stages(await self.own(owner, board), owner)
        # The board folder itself shows as its first stage.
        stage_of = {s.folder: s for s in stages} | {board: stages[0]}
        placements = await self._placements(owner)
        gate = asyncio.Semaphore(MAX_LOOKUPS)

        async def look(ref: str) -> Conversation | None:
            async with gate:
                conv = await self._conversation(ref)
            on_board = conv is not None and conv.owner == owner and placements.get(conv.id) in stage_of
            return conv if on_board else None

        asked = list(dict.fromkeys(conversations))
        on = {c.key: c for c in await asyncio.gather(*(look(c) for c in asked)) if c is not None}
        view = await self.store.board_view(list(on))
        # Blockers outside the asked cards still need their stage.
        rest = {k for ks in view.blockers.values() for k in ks} - on.keys()
        near = on | {c.key: c for c in await asyncio.gather(*(look(k) for k in rest)) if c is not None}

        # As in `blockers`, only cards on this board block.
        def blocker(k: str) -> dict:
            stage = stage_of[placements[near[k].id]]
            return Blocker(near[k].id, near[k].title, stage.name, stage == stages[-1]).payload()

        return {
            conv.id: {
                "card": view.cards[key].payload() if key in view.cards else None,
                "blockers": [blocker(k) for k in view.blockers.get(key, []) if k in near],
                "tags": view.tags.get(key, []),
                "priority": view.details.get(key, Details()).payload()["priority"],
            }
            for key, conv in on.items()
        }

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
        on = await self._board_of(key, owner)
        if on is None:
            return []
        _, board, placements = on
        return await self.blockers(key, owner, board, placements=placements)

    async def _board_of(self, key: str, owner: str) -> tuple[Conversation, str, dict[str, str]] | None:
        """`key`'s conversation, the board `owner` filed it on, and their placements; None off every board."""
        conv = await self._conversation(key)
        if conv is None or conv.owner != owner:
            return None
        placements = await self._placements(owner)
        found = await self.at(placements.get(conv.id) or "")
        if found is None or found[0].owner != owner:
            return None
        return conv, found[0].board, placements

    async def dependents_of(self, key: str, owner: str) -> list[Blocker]:
        """The cards on `key`'s board that wait on it, each with its own stage."""
        keys = await self.store.dependents(key)
        on = await self._board_of(key, owner) if keys else None
        if on is None:
            return []
        _, board, placements = on
        last = (await self.stages(board, owner))[-1]
        out: list[Blocker] = []
        for k in keys:
            conv = await self._conversation(k)
            stage = await self._stage_of(conv, owner, board, placements) if conv else None
            if conv is not None and stage is not None:
                out.append(Blocker(conv.id, conv.title, stage.name, stage.folder == last.folder))
        return out

    async def user_set_blockers(self, owner: str, key: str, refs: list[str]) -> list[Blocker]:
        """The user replaces a card's blockers; clearing its last open one tells its agent."""
        on = await self._board_of(key, owner)
        if on is None:
            raise BoardError(409, "this conversation isn't filed on one of your boards")
        conv, board, placements = on
        waited = any(not b.done for b in await self.blockers(key, owner, board, placements=placements))
        blockers = await self.set_blockers(owner, board, conv, refs, by="user")
        if waited and all(b.done for b in blockers) and self.send is not None:
            try:
                await self.send(
                    conv.id,
                    "The user removed the open blockers from this card on the kanban board. "
                    "You can move it on to its next stage now.",
                )
            except httpx.HTTPError as e:
                logger.warning("kanban unblock message failed", extra={"conversation_id": conv.id, "error": str(e)})
        return blockers

    async def set_details(
        self, key: str, *, by: str, description: str | None = None, priority: str | None = None, owner: str = ""
    ) -> Details:
        """Change a card's description or priority, named as `parse_priority` takes it.

        With `owner`, the user's edit: only to a conversation of theirs, not one shared with them.
        """
        conv = await self._conversation(key) if owner else None
        if owner and (conv is None or conv.owner != owner):
            raise BoardError(404, "you can only change the details of your own conversations")
        level = None if priority is None else parse_priority(priority)
        details = await self.store.set_details(key, by=by, description=description, priority=level)
        if conv is not None:
            await self.changed(owner, conv.id)
        else:
            await self.changed_card(key)
        return details

    @staticmethod
    def _color(color: str) -> str:
        if color not in TAG_COLORS:
            raise BoardError(400, f"color must be one of {', '.join(TAG_COLORS)}")
        return color

    async def tag_card(
        self, owner: str, key: str, tags: list[str], *, board: str = "", create: list[str] | None = None
    ) -> tuple[list[str], list[Tag]]:
        """The user replaces a card's tags, all from one of their boards, by id.

        `create` names tags to add to `board` and put on the card too; one the board
        already has is used as is. Returns the card's tag ids and the tags made.
        """
        tags = list(dict.fromkeys(tags))
        names = list(dict.fromkeys(n.strip() for n in create or [] if n.strip()))
        if board:
            await self.own(owner, board)
        if names and not board:
            raise BoardError(400, "board is required to create tags")
        if tags:
            board_of = await self.store.tag_boards(owner, tags)
            on = {board_of.get(t) for t in tags}
            if None in on or len(on) != 1 or (board and on != {board}):
                raise BoardError(400, "tags must be ids of one of your boards' tags")
        made: list[Tag] = []
        if names:
            have = await self.store.tags(board)
            by_name = {t.name.casefold(): t for t in have}
            for n in names:
                if n.casefold() in by_name:
                    tags.append(by_name[n.casefold()].id)
                    continue
                if len(n) > MAX_TAG_CHARS:
                    raise BoardError(400, f"a tag name is at most {MAX_TAG_CHARS} characters")
                used = [t.color for t in [*have, *made]]
                last = (made or have)[-1].position if made or have else 0.0
                made.append(Tag("", n, _pick_color(used), last + 1))
            if len(have) + len(made) > MAX_BOARD_TAGS:
                raise BoardError(409, f"a board has at most {MAX_BOARD_TAGS} tags")
            tags = list(dict.fromkeys(tags))
        if len(tags) + len(made) > MAX_CARD_TAGS:
            raise BoardError(400, f"a card has at most {MAX_CARD_TAGS} tags")
        made = await self.store.set_card_tags(key, tags, board_id=board, create=made)
        # New tags change the board, not just the card.
        await (self.changed(owner) if made else self.changed_card(key, owner))
        return [*tags, *(t.id for t in made)], made

    async def set_tags(self, key: str, names: list[str]) -> Located:
        """The agent replaces its card's tags, by name, from its board's tags."""
        where = await self.locate(key)
        board = await self.store.tags(where.place.board)
        by_name = {t.name.casefold(): t for t in board}
        unknown = [n for n in names if n.strip().casefold() not in by_name]
        if unknown:
            have = ", ".join(f"`{t.name}`" for t in board) or "none"
            raise BoardError(400, f"{', '.join(f'`{n}`' for n in unknown)} not on this board; its tags: {have}")
        picked = list(dict.fromkeys(by_name[n.strip().casefold()].id for n in names))
        if len(picked) > MAX_CARD_TAGS:
            raise BoardError(400, f"a card has at most {MAX_CARD_TAGS} tags")
        await self.store.set_card_tags(key, picked)
        await self.changed(where.conversation.owner, where.conversation.id)
        return where

    async def tag_view(self, key: str, board: str) -> dict[str, list[Tag]]:
        """A board's tags and the card's, as `view` takes them."""
        tags = await self.store.tags(board)
        mine = set(await self.store.card_tags(key))
        return {"tags": tags, "card_tags": [t for t in tags if t.id in mine]}
