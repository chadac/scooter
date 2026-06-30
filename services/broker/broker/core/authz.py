"""Authorization seam — the broker's policy ENFORCEMENT point.

The broker decides who may do credential/permission-sensitive things (today:
which human may APPROVE an AWS request for a given account; later: agent
permission boundaries — may this conversation/agent request scope X?). This lives
in the broker, not the agent-host, so all such checks share one enforcement point.

Backed by OpenFGA (ReBAC / Zanzibar) when configured; a no-op (allow-all) when
not, so the broker behaves exactly as before until FGA is wired up.

The rest of the broker depends only on the `Authorizer` protocol — never on the
OpenFGA SDK directly — so "FGA off" is clean and tests inject a fake.
"""

from __future__ import annotations

import logging
from typing import Protocol

logger = logging.getLogger(__name__)


def _is_duplicate_tuple_error(exc: Exception) -> bool:
    """True if an OpenFGA write error is the idempotent "tuple already exists"
    case (safe to ignore) vs a real failure (must propagate).

    OpenFGA returns this as an HTTP 400 with code `write_failed_due_to_invalid_input`
    and a message mentioning the existing tuple. We match on the message/code
    rather than the SDK exception class so this stays correct without importing
    the (optional, lazily-loaded) openfga-sdk — and errs toward "NOT a duplicate"
    so an unrecognized error propagates rather than being silently swallowed.
    """
    text = f"{getattr(exc, 'body', '')} {exc}".lower()
    return (
        "write_failed_due_to_invalid_input" in text
        or "already exists" in text
        or "duplicate" in text
    )


class Authorizer(Protocol):
    async def check(self, *, user: str, relation: str, obj: str) -> bool:
        """True if `user` has `relation` to `obj` (e.g. user "alice",
        relation "approver", obj "aws_account:dev")."""
        ...

    async def grant(self, *, user: str, relation: str, obj: str) -> None:
        """Record a relationship tuple (used to SEED approver tuples at startup)."""
        ...


class NoopAuthorizer:
    """FGA unconfigured -> allow everything (the broker's behavior before FGA).
    grant() is a no-op."""

    async def check(self, *, user: str, relation: str, obj: str) -> bool:
        return True

    async def grant(self, *, user: str, relation: str, obj: str) -> None:
        return None


class FgaAuthorizer:
    """OpenFGA-backed authorizer (lazy SDK import so the dep is only needed when
    FGA is actually enabled)."""

    def __init__(self, *, api_url: str, store_id: str, model_id: str | None = None) -> None:
        self._api_url = api_url
        self._store_id = store_id
        self._model_id = model_id
        self._client = None  # built lazily on first use

    def _ensure_client(self):
        if self._client is None:
            # Imported here so `openfga-sdk` is only required when FGA is enabled.
            from openfga_sdk import ClientConfiguration, OpenFgaClient

            cfg = ClientConfiguration(
                api_url=self._api_url,
                store_id=self._store_id,
                authorization_model_id=self._model_id,
            )
            self._client = OpenFgaClient(cfg)
        return self._client

    async def check(self, *, user: str, relation: str, obj: str) -> bool:
        from openfga_sdk.client.models import ClientCheckRequest

        client = self._ensure_client()
        try:
            res = await client.check(ClientCheckRequest(user=user, relation=relation, object=obj))
            return bool(getattr(res, "allowed", False))
        except Exception:
            # Fail CLOSED for a permission gate: if FGA is unreachable, deny.
            logger.exception("OpenFGA check failed (denying): %s#%s@%s", obj, relation, user)
            return False

    async def grant(self, *, user: str, relation: str, obj: str) -> None:
        from openfga_sdk.client.models import ClientTuple, ClientWriteRequest

        client = self._ensure_client()
        try:
            await client.write(
                ClientWriteRequest(writes=[ClientTuple(user=user, relation=relation, object=obj)])
            )
        except Exception as exc:
            # Finding #2: a duplicate tuple (already granted) is a genuine no-op;
            # but EVERY OTHER write failure (FGA unreachable, wrong store/model,
            # network) must PROPAGATE — swallowing it at DEBUG meant the tuple was
            # never written, and since check() fails CLOSED the approver is then
            # permanently and silently locked out. Re-raise so the caller's loud
            # handler (seed_approver_tuples -> logger.exception) actually fires.
            if _is_duplicate_tuple_error(exc):
                logger.debug("OpenFGA grant no-op (tuple exists) for %s#%s@%s", obj, relation, user)
                return
            raise


def authorizer_from_settings(settings) -> Authorizer:
    """Build the authorizer from broker settings. FGA off (default) -> NoopAuthorizer."""
    if getattr(settings, "fga_enabled", False) and getattr(settings, "fga_api_url", "") and getattr(settings, "fga_store_id", ""):
        return FgaAuthorizer(
            api_url=settings.fga_api_url,
            store_id=settings.fga_store_id,
            model_id=getattr(settings, "fga_authorization_model_id", "") or None,
        )
    return NoopAuthorizer()


def aws_account_object(account: str) -> str:
    """The OpenFGA object id for an AWS account (registry alias)."""
    return f"aws_account:{account}"


def user_object(user: str) -> str:
    """The OpenFGA user id for a human."""
    return f"user:{user}"
