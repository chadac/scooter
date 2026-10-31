"""The ssh provider: the key store, its routes, and the public-key lookup forges register from."""

from __future__ import annotations

from scooter_broker_lib import ssh_keys
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider

from .config import SshSettings
from .store import SshKeyStore
from .transport import SshKey


@register_provider
def ssh(ctx: BrokerContext) -> Provider:
    transport = SshKey()
    if not SshSettings().ssh_enabled or ctx.owners is None or ctx.user_secrets is None:
        return Provider(name="ssh", transports=[transport], enabled=False)

    store = SshKeyStore(ctx.contrib_store_config("ssh"), ctx.user_secrets)
    transport.store, transport.owners = store, ctx.owners

    async def lookup(user: str) -> str | None:
        key, _ = await store.get_or_create(user)
        return key.public_key

    ssh_keys.provide_lookup(lookup)
    return Provider(name="ssh", transports=[transport], enabled=True)
