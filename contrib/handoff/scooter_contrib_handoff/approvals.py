"""Spawn approvals: the owner approves each handoff before its conversation exists.

The requests, their routes at /handoff/approvals and their cards are
scooter_broker_lib.approvals; this module is the card prose and the two verbs.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from scooter_broker_lib.approvals import ApprovalRequest, Approvals, Approver, Card, Decision

from .spawn import SpawnFailed, Spawner

KIND = "handoff.spawn"
# Pending requests one conversation may hold at once.
MAX_PENDING = 3


@dataclass(frozen=True)
class Spawn:
    brief: str
    title: str = ""
    model: str = ""
    # The owner's folder to file the new conversation in.
    folder: str | None = None


def card(req: ApprovalRequest[Spawn]) -> Card:
    s = req.payload
    head = f"The agent wants to hand off to a new conversation: {s.title or 'Handoff'}"
    head += f", filed in folder {s.folder}" if s.folder else ""
    head += f" (model {s.model})" if s.model else " (default model)"
    return Card(message=f"{head}.\n\nBrief:\n{s.brief}", data=asdict(s))


def _label(s: Spawn) -> str:
    return f'"{s.title}"' if s.title else "request"


def _started(s: Spawn, made: dict) -> str:
    """The agent's news of an approved spawn, and where it was filed."""
    out = (
        f"The user approved your handoff {_label(s)}. It started as conversation "
        f"{made['conversation_id']} ({made['url']}) with your brief as its first message."
    )
    if s.folder and made.get("filed"):
        out += f" It is filed in folder {s.folder}."
    elif s.folder:
        out += f" It could not be filed in folder {s.folder}; the user can file it from the sidebar."
    return out


def spawn_approvals(spawner: Spawner | None) -> Approvals[Spawn]:
    """The approvals whose Approve spawns through `spawner`."""
    spawns = Approvals(contrib="handoff", kind=KIND, payload=Spawn, render=card, max_pending=MAX_PENDING)

    @spawns.on("approve")
    async def approve(req: ApprovalRequest[Spawn], who: Approver) -> Decision:
        if spawner is None:
            raise SpawnFailed("AGENT_HOST_URL is not set")
        made = await spawner.spawn(req.conversation_id, **asdict(req.payload))
        return Decision(_started(req.payload, made), body=made)

    @spawns.on("deny")
    async def deny(req: ApprovalRequest[Spawn], who: Approver) -> Decision:
        return Decision(f"The user denied your handoff {_label(req.payload)}; no conversation was created.")

    return spawns
