"""The seam between the ssh contrib and the forges that register its keys.

ssh owns each user's key and announces changes; a forge contrib (github,
gitlab) listens so it can register the new key on the user's account and remove
the old one. Neither imports the other, and with ssh disabled the lookup
returns None and nothing is announced.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Awaitable, Callable

from scooter_lib.logging_config import format_error

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class SshKeyChange:
    """A user's key was created or rotated; `old` is None on creation."""

    user: str
    new: str
    old: str | None = None


Listener = Callable[[SshKeyChange], Awaitable[None]]
Lookup = Callable[[str], Awaitable["str | None"]]

_listeners: list[Listener] = []
_lookup: Lookup | None = None


def on_ssh_key_change(listener: Listener) -> Listener:
    """Register `listener` for every key change; usable as a decorator."""
    _listeners.append(listener)
    return listener


async def announce(change: SshKeyChange) -> None:
    """Tell every listener; one failing does not stop the rest."""
    for listener in list(_listeners):
        try:
            await listener(change)
        except Exception as e:  # noqa: BLE001 - a forge outage must not fail a rotate
            logger.warning(
                "ssh key change listener failed",
                extra={"listener": getattr(listener, "__qualname__", repr(listener)), "error": format_error(e)},
            )


def provide_lookup(lookup: Lookup | None) -> None:
    """Set (or clear) how to read a user's public key, creating it if needed."""
    global _lookup
    _lookup = lookup


async def public_key(user: str) -> str | None:
    """The user's OpenSSH public key line, None when no ssh contrib is enabled."""
    return await _lookup(user) if _lookup is not None else None
