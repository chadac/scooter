"""A GitHub message's sender, from the signed payload only."""

from __future__ import annotations

from scooter_webhooks_lib.sender import Level, Sender

# GitHub's author_association, the repo's own word on the author's standing.
_ASSOCIATION_LEVELS = {
    "OWNER": Level.MEMBER,
    "MEMBER": Level.MEMBER,
    "COLLABORATOR": Level.MEMBER,
    "CONTRIBUTOR": Level.CONTRIBUTOR,
    "FIRST_TIME_CONTRIBUTOR": Level.GUEST,
    "FIRST_TIMER": Level.GUEST,
    "NONE": Level.GUEST,
}


def association_level(association: str | None) -> Level:
    """The level an author_association proves; anything unrecognized is UNKNOWN."""
    return _ASSOCIATION_LEVELS.get((association or "").upper(), Level.UNKNOWN)


def sender_from(user: dict | None, association: str | None = None) -> Sender | None:
    """The Sender for a payload `user` object, or None when it has no numeric id."""
    user = user or {}
    uid = user.get("id")
    # A bool id is malformed, not user 1.
    if not isinstance(uid, int) or isinstance(uid, bool):
        return None
    return Sender(
        provider="github",
        external_id=str(uid),
        handle=user.get("login") or "",
        level=association_level(association),
    )


def actor_on(payload: dict, resource: dict) -> Sender | None:
    """The event's actor; the resource's association counts only when the actor is its author."""
    actor = payload.get("sender") or {}
    author = resource.get("user") or {}
    same = actor.get("id") is not None and actor.get("id") == author.get("id")
    return sender_from(actor, resource.get("author_association") if same else None)
