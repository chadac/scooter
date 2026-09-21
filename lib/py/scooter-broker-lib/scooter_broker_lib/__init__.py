"""scooter_broker_lib — the broker extension surface.

Everything a broker provider composes, extracted from the broker app so a
provider (in-tree today, a contrib tomorrow) can build-depend on it directly —
retiring the "declare no dependency, resolve at runtime" trick the echo contrib
uses now. Depends only on `scooter_lib`; it imports NOTHING from the broker app
and NOTHING from `scooter_webhooks_lib` (the two extension surfaces are mutually
exclusive).

Planned contents (moved from `broker/` per the boundary agreed on the PR):
  * types      — Provider / Transport / Identity / Credential / CredentialSource
                 / AuthDependency (broker/core/types.py)
  * registry   — register_provider / discover_providers + the entry-point loader,
                 with the built-in scan parameterized so it is not hardcoded to
                 `broker.providers` (broker/core/registry.py)
  * autolink   — Link / LinkRule / rule / post_link (broker/core/autolink.py)
  * sources/   — static_token, github_app, atlassian_oauth, datadog_keys
  * transports/— http_proxy, git_credential, whoami, token_vend
                 (aws_permissions stays in the app: it pulls the AWS subsystem)

Skeleton pending boundary sign-off; contents land in follow-up commits.
"""
