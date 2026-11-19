"""The apikeys provider: the key store, its routes, and who may verify keys."""

from __future__ import annotations

from collections.abc import Mapping

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_lib.svcauth import Policy, Principal, Verifier, in_cluster_reviewer, parse_allowlist

from .config import ApiKeysSettings
from .store import ApiKeyStore
from .transport import ApiKeys


@register_provider
def apikeys(ctx: BrokerContext) -> Provider:
    transport = ApiKeys()
    settings = ApiKeysSettings()
    if not settings.apikeys_enabled:
        return Provider(name="apikeys", transports=[transport], enabled=False)

    transport.store = ApiKeyStore(ctx.contrib_store_config("apikeys"))
    allowed = parse_allowlist(settings.apikeys_verifier_service_accounts)
    if allowed:
        verifier = Verifier(in_cluster_reviewer(settings.apikeys_token_audience))
        policy = Policy(services=allowed)

        async def check(headers: Mapping[str, str]) -> Principal:
            return await verifier.resolve(headers, policy)

        transport.verifier = check
    return Provider(name="apikeys", transports=[transport], enabled=True)
