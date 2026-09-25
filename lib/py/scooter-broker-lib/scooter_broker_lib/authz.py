"""The authorization CONTRACT a provider is authorized against — not an implementation.

Authz is substrate, not a feature (#595): the broker is the one enforcement point for
"which human may approve this", and a provider — in-tree or a contrib — must not be
able to answer that question on its own behalf. So what lives on the surface is the
protocol a provider is typed against, plus the allow-all stand-in the broker uses when
FGA is unconfigured. The OpenFGA implementation, its SDK dependency and the settings
that select it stay in the broker app (`broker/core/authz.py`), and the app hands the
built authorizer to each provider through `BrokerContext` (see context.py).

That split is the whole point. If a contrib could BUILD its authorizer it could also
build a NoopAuthorizer and grant itself everything — the gate would be advisory. It
can only receive one.
"""

from __future__ import annotations

from typing import Protocol


class Authorizer(Protocol):
    async def check(self, *, user: str, relation: str, obj: str) -> bool:
        """True if `user` has `relation` to `obj` (e.g. user "alice",
        relation "approver", obj "aws_account:dev")."""
        ...

    async def grant(self, *, user: str, relation: str, obj: str) -> None:
        """Record a relationship tuple (used to SEED approver tuples at startup).

        A provider owns its own object namespace, so it seeds its own tuples —
        only it knows that an account alias means `aws_account:<alias>`.
        """
        ...


class NoopAuthorizer:
    """FGA unconfigured -> allow everything (the broker's behavior before FGA).
    grant() is a no-op."""

    async def check(self, *, user: str, relation: str, obj: str) -> bool:
        return True

    async def grant(self, *, user: str, relation: str, obj: str) -> None:
        return None


def user_object(user: str) -> str:
    """The OpenFGA user id for a human. Generic: every provider's tuples name a
    human the same way, even though the OBJECT half is the provider's own."""
    return f"user:{user}"
