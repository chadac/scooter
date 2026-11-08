"""commits' agent tools, listed only in the owner's private conversation.

The user is always the conversation's acting user, never an argument. An agent
reads the identity and proposes one when none is set; only the user's approval,
in the Approvals tab, writes it.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.approvals import Approvals
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate
from scooter_broker_lib.owner import OwnerResolver

from .approvals import SETTINGS, Proposed
from .store import CommitIdentityStore, InvalidIdentity, validated

mcp = FastMCP(name="commits")

# Set by the provider factory.
_store: CommitIdentityStore | None = None
_owners: OwnerResolver | None = None
_proposals: Approvals[Proposed] | None = None


def configure(
    store: CommitIdentityStore | None, owners: OwnerResolver | None, proposals: Approvals[Proposed] | None = None,
) -> None:
    global _store, _owners, _proposals
    _store, _owners, _proposals = store, owners, proposals


async def _acting(ctx: ToolContext) -> str | None:
    if _store is None or _owners is None or _proposals is None:
        return None
    return await _owners.acting_user(ctx.identity)


async def _is_private(ctx: ToolContext) -> bool:
    return await _acting(ctx) is not None


@gate(_is_private)
@mcp.tool
async def commit_identity_get(ctx: ToolContext = ToolContextDep) -> ToolResult:
    """The name and email the user's commits carry, who set it, and any proposal awaiting approval.

    If none is set and none is pending, work out the identity the user usually commits
    under and pass it to commit_identity_propose (see the commit-identity skill).
    """
    user = await _acting(ctx)
    if user is None or _store is None or _proposals is None:
        return ToolResult.error("no commit identity outside the owner's private conversation")
    chosen = await _store.get(user)
    if chosen is not None:
        return ToolResult.ok(f"{chosen.person.ident()} (set by {chosen.set_by})")
    pending = await _proposals.pending(owner=user)
    if pending:
        idents = ", ".join(p.payload.person.ident() for p in pending)
        return ToolResult.ok(f"No commit identity is set. Awaiting the user's approval: {idents}.")
    return ToolResult.ok("No commit identity is set.")


@gate(_is_private)
@mcp.tool
async def commit_identity_propose(name: str, email: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Ask the user to approve this as their commit identity; only possible while none is set.

    It shows as a card in the user's Approvals tab and takes effect only when they
    approve it. Do not wait on it: carry on, and tell the user it is waiting there.
    """
    user = await _acting(ctx)
    if user is None or _store is None or _proposals is None:
        return ToolResult.error("no commit identity outside the owner's private conversation")
    try:
        person = validated(name, email)
    except InvalidIdentity as e:
        return _refused(str(e))
    if await _store.get(user) is not None:
        return _refused("an identity is already set")
    conversation = ctx.identity.conversation_id
    mine = await _proposals.pending(conversation_id=conversation, owner=user)
    if mine:
        return _refused(f"this conversation's proposal of {mine[0].payload.person.ident()} is still pending")
    await _proposals.request(conversation, Proposed(person.name, person.email), owner=user)
    return ToolResult.ok(
        f"Proposed {person.ident()}; it is waiting in the user's Approvals tab and applies once they approve."
    )


def _refused(why: str) -> ToolResult:
    return ToolResult.error(f"refused: {why}. The user sets it at {SETTINGS}.")


def commits_mcp_server() -> FastMCP:
    return mcp
