"""The shares provider: publish static bundles and serve them at /s/<uuid>/.

Mounted at the broker's root rather than under /shares, because published share URLs
are /s/<uuid>/ and those links are already out in the world.
"""

from __future__ import annotations

from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.state import publish_state
from scooter_broker_lib.types import Provider

from .config import settings
from .store import ShareStore
from .transport import Shares


@register_provider
def shares(ctx: BrokerContext) -> Provider:
    transport = Shares(
        ShareStore(ctx.contrib_store_config("shares")),
        public_base_url=settings.shares_public_base_url,
        frame_ancestors=settings.shares_frame_ancestors,
        on_change=lambda conversation_id: publish_state(settings.agent_host_url, conversation_id, "shares"),
    )
    return Provider(name="shares", transports=[transport], mount_at_root=True)
