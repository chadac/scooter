"""Resolving a conversation's ATTACHED RESOURCE from its links.

Every provider reply tool asks the same question — "which PR / MR / issue / thread is
this conversation attached to, and is it attached at all?" — and the answer decides
both whether the tool is offered (the attachment gate) and what it acts on. Getting it
wrong means commenting on the wrong resource, so the rules here are a faithful port of
the agent-host implementation they replace (services/agent-host/src/agent/agentTools.ts),
including the two that exist because of specific incidents.

ORDER: OLDEST LINK FIRST. `listLinks` orders by insert id, so the resource the
conversation was STARTED from wins over one the agent created later. A conversation
opened from PR #1 that then opens PR #2 still replies on #1.

COMPLETENESS IS PER LINK. A target is taken whole from ONE link or not at all; fields
are never mixed across links. Half a ref plus half of another once produced an owner
from one repo and a number from another — a comment on an unrelated PR.

Each provider supplies its own `resolve`, because only it knows its id grammar. The
mechanics are here; the grammar stays in the contrib (see each contrib's `refs.py`).
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from typing import Any, TypeVar

T = TypeVar("T")

# A link row as the agent-host's GET /conversations/{id}/links returns it:
# {"source", "resourceType", "url", "title", "ref": {...}}.
Link = dict[str, Any]


def links_for(links: Sequence[Link], source: str) -> list[Link]:
    """This source's links, in the order given — oldest first. See the module note."""
    return [link for link in links if link.get("source") == source]


def ref_of(link: Link) -> dict[str, Any]:
    """A link's structured `ref`, or an empty mapping. Never None, so a caller can
    index it without a guard."""
    ref = link.get("ref")
    return ref if isinstance(ref, dict) else {}


def first_target(
    links: Sequence[Link],
    source: str,
    resolve: Callable[[Link], T | None],
) -> T | None:
    """The first link of `source` that yields a COMPLETE target.

    `resolve` returns the target or None; returning a partial target is the caller's
    bug, and the reason this takes a whole-link resolver rather than per-field
    accessors — there is no way to express "mix these" through it.
    """
    for link in links_for(links, source):
        target = resolve(link)
        if target is not None:
            return target
    return None


def resource_type_is(resource_type: str, *, truthy: Sequence[str], falsy: Sequence[str]) -> bool | None:
    """Classify a link's `resourceType` against two spelling sets.

    Each writer spells these differently — the webhooks handler writes
    "merge_request", the broker's auto-link writes "mr" — so a tool cannot match one
    spelling and must not guess from an unrecognised one. Returns None when it is
    neither, leaving the caller to fall back to something it does trust.
    """
    lowered = (resource_type or "").strip().lower()
    if lowered in truthy:
        return True
    if lowered in falsy:
        return False
    return None
