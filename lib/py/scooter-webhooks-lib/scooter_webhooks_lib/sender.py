"""Who sent an inbound message, and how close they are to the conversation.

A contrib builds a Sender from a signed payload, using only the platform's stable
id and platform signals for the level. The agent-host records it on the message.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass


class Level(enum.IntEnum):
    """How close a sender is to a conversation; lower is closer."""

    SELF = 0
    VOUCHED = 20
    MEMBER = 40
    CONTRIBUTOR = 60
    GUEST = 80
    UNKNOWN = 100


# SELF and VOUCHED come from agent-host state, never webhooks.
CONTRIB_LEVELS = frozenset({Level.MEMBER, Level.CONTRIBUTOR, Level.GUEST, Level.UNKNOWN})

PROVIDERS = frozenset({"github", "gitlab", "slack", "jira"})


@dataclass(frozen=True)
class Sender:
    """One account in one system, plus the level its platform signals prove."""

    provider: str
    # The system's stable id, never a login or display name.
    external_id: str
    handle: str
    level: Level = Level.UNKNOWN
    display_name: str | None = None

    def __post_init__(self) -> None:
        if self.provider not in PROVIDERS:
            raise ValueError(f"unknown sender provider: {self.provider!r}")
        if not self.external_id:
            raise ValueError("a sender needs a stable external_id")
        if self.level not in CONTRIB_LEVELS:
            raise ValueError(f"a contrib cannot assign level {self.level!r}")

    def to_payload(self) -> dict:
        """The `sender` object the agent-host's /agui accepts."""
        out: dict = {
            "provider": self.provider,
            "externalId": self.external_id,
            "handle": self.handle,
            "level": int(self.level),
        }
        if self.display_name:
            out["displayName"] = self.display_name
        return out

    @classmethod
    def from_payload(cls, data: dict) -> Sender:
        """The inverse of to_payload, for a sender stored with a queued message."""
        return cls(
            provider=data["provider"],
            external_id=data["externalId"],
            handle=data.get("handle", ""),
            level=Level(data.get("level", Level.UNKNOWN)),
            display_name=data.get("displayName"),
        )


def closest(*levels: Level) -> Level:
    """The closest level any signal proves; no signal is UNKNOWN."""
    return min(levels, default=Level.UNKNOWN)
