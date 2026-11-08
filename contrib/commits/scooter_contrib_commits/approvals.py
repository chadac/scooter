"""Identity proposals: an agent's guess at the user's commit identity, which the user approves.

The requests, their routes at /commits/approvals and their cards are
scooter_broker_lib.approvals; this module is the card and the two verbs. Approving
writes the identity unless one is set by then, and withdraws the user's other
proposals.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

from scooter_broker_lib.approvals import ApprovalRequest, Approvals, Approver, Card, Decision
from scooter_broker_lib.commit_identity import Person

from .store import CommitIdentityStore

KIND = "commits.identity"
SETTINGS = "Settings → Commit identity"


@dataclass(frozen=True)
class Proposed:
    name: str
    email: str

    @property
    def person(self) -> Person:
        return Person(self.name, self.email)


def card(req: ApprovalRequest[Proposed]) -> Card:
    """ui/ProposalCard.tsx draws `data`."""
    return Card(message=f"The agent proposes your commit identity: {req.payload.person.ident()}", data=asdict(req.payload))


def identity_approvals(store: CommitIdentityStore) -> Approvals[Proposed]:
    """The approvals whose Approve writes the identity into `store`."""
    # One per conversation; commit_identity_propose refuses more.
    proposals = Approvals(contrib="commits", kind=KIND, payload=Proposed, render=card, max_pending=None)

    @proposals.on("approve")
    async def approve(req: ApprovalRequest[Proposed], who: Approver) -> Decision:
        chosen = await store.adopt(req.owner, req.payload.person)
        await withdraw_pending(proposals, req.owner)
        return Decision(
            f"The user approved {chosen.person.ident()} as their commit identity; your commits now carry it.",
            body={"identity": chosen.payload()},
        )

    @proposals.on("deny")
    async def deny(req: ApprovalRequest[Proposed], who: Approver) -> Decision:
        return Decision(
            f"The user denied {req.payload.person.ident()} as their commit identity. "
            f"Don't propose it again; they can set one at {SETTINGS}."
        )

    return proposals


async def withdraw_pending(proposals: Approvals[Proposed], user: str) -> None:
    """Retire the user's proposals and their cards, once an identity is set."""
    for p in await proposals.pending(owner=user):
        await proposals.withdraw(p)
