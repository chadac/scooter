"""scooter_webhooks_lib — the webhooks extension surface.

What a webhooks handler composes, extracted from the webhooks app so a handler
(in-tree today, a contrib tomorrow) can build-depend on it directly. Depends on
`scooter_lib` (+ `scooter_schema` for the mapping store); it imports NOTHING
from the webhooks app and NOTHING from `scooter_broker_lib` (the two extension
surfaces are mutually exclusive).

Contents:
  * registry — WebhookHandler / register_webhook / discover_webhooks. The
               built-in scan is a PARAMETER (the app passes its own
               `webhooks.handlers`), which is what lets this live here.
  * store    — the conversation-mapping store (+ PENDING_CONVERSATION_ID). Takes
               its database settings as an argument typed by a protocol, so the
               app's config.py stays in the app.

STILL IN THE APP, deliberately — see PR #567:
  * config.py — stays put, as agreed.
  * agent_host_client, identity_resolve — both read the app's module-level
    `settings` singleton at call time (agent_host_url, agent_host_token_path,
    agent_manager_url, and the per-provider tokens). Moving them means choosing
    how a lib module gets its configuration, which is a design question of its
    own rather than a file move. Tracked as a TODO rather than half-done here.
  * responses/ — provider-specific; migrates WITH each provider's handler in the
    later integration slices.
"""

from .registry import WebhookHandler, discover_webhooks, register_webhook

__all__ = ["WebhookHandler", "discover_webhooks", "register_webhook"]
