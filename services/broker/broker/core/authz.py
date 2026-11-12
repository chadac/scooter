"""Authorization seam: the broker's policy enforcement point, backed by OpenFGA when
configured and an allow-all no-op otherwise.

The rest of the broker depends only on the `Authorizer` protocol, which lives with
NoopAuthorizer and user_object in scooter_broker_lib.authz so a provider can be typed
against it; the OpenFGA implementation stays here and the app hands the built authorizer
to each provider via BrokerContext.
"""

from __future__ import annotations

import logging

from scooter_broker_lib.authz import Authorizer, NoopAuthorizer, user_object

__all__ = [
    "Authorizer",
    "NoopAuthorizer",
    "FgaAuthorizer",
    "authorizer_from_settings",
    "user_object",
]

logger = logging.getLogger(__name__)


class FgaAuthorizer:
    """OpenFGA-backed authorizer, importing the SDK lazily so it is only needed when FGA is enabled."""

    def __init__(self, *, api_url: str, store_id: str, model_id: str | None = None) -> None:
        self._api_url = api_url
        self._store_id = store_id
        self._model_id = model_id
        self._client = None

    def _ensure_client(self):
        if self._client is None:
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
            # A permission gate fails closed.
            logger.exception(
                "OpenFGA check failed; denying",
                extra={"fga_object": obj, "relation": relation, "fga_user": user},
            )
            return False

    async def grant(self, *, user: str, relation: str, obj: str) -> None:
        from openfga_sdk.client.models import (
            ClientTuple,
            ClientWriteRequest,
            ClientWriteRequestOnDuplicateWrites,
            ConflictOptions,
        )

        # Ignore duplicates server-side; startup re-seeding rewrites existing tuples.
        await self._ensure_client().write(
            ClientWriteRequest(writes=[ClientTuple(user=user, relation=relation, object=obj)]),
            options={"conflict": ConflictOptions(
                on_duplicate_writes=ClientWriteRequestOnDuplicateWrites.IGNORE,
            )},
        )


def authorizer_from_settings(settings) -> Authorizer:
    """Build the authorizer from broker settings, a NoopAuthorizer when FGA is off."""
    if getattr(settings, "fga_enabled", False) and getattr(settings, "fga_api_url", "") and getattr(settings, "fga_store_id", ""):
        return FgaAuthorizer(
            api_url=settings.fga_api_url,
            store_id=settings.fga_store_id,
            model_id=getattr(settings, "fga_authorization_model_id", "") or None,
        )
    return NoopAuthorizer()
