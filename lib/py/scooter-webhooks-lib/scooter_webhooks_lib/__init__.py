"""scooter_webhooks_lib — the webhooks extension surface.

Everything a webhooks handler composes, extracted from the webhooks app so a
handler (in-tree today, a contrib tomorrow) can build-depend on it directly.
Depends on `scooter_lib` (+ `scooter_schema` for the mapping store); it imports
NOTHING from the webhooks app and NOTHING from `scooter_broker_lib` (the two
extension surfaces are mutually exclusive).

Planned contents (moved from `webhooks/` per the boundary agreed on the PR):
  * registry          — WebhookHandler / register_webhook / discover_webhooks,
                        built-in scan parameterized off `webhooks.handlers`
  * agent_host_client — create_conversation / conversation_url / push_link /
                        send_message (the provider-agnostic spawn client)
  * identity_resolve  — resolve_owner (external identity -> internal owner)
  * store             — the conversation-mapping store (+ PENDING_CONVERSATION_ID)
  * config            — the base settings these need (DB + relay key); the
                        per-provider secrets stay with their handlers as those
                        migrate to contribs

Provider-specific `responses/*` stay in the app and migrate WITH each provider's
handler in the later integration slices.

Skeleton pending boundary sign-off; contents land in follow-up commits.
"""
