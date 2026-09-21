"""scooter_broker_lib — the broker extension surface.

Everything a broker provider composes, extracted from the broker app so a
provider (in-tree today, a contrib tomorrow) can build-depend on it directly —
retiring the "declare no dependency, resolve at runtime" trick the echo contrib
used before PR #567. Depends only on `scooter_lib`; it imports NOTHING from the
broker app and NOTHING from `scooter_webhooks_lib` (the two extension surfaces
are mutually exclusive).

Contents:
  * types      — Provider / Transport / Identity / Credential / CredentialSource
                 / AuthDependency
  * registry   — register_provider / discover_providers + the entry-point loader.
                 The built-in scan is a PARAMETER (the app passes its own
                 `broker.providers`), which is what lets the registry live here
                 at all.
  * autolink   — Link / LinkRule / rule / post_link / create_link / list_links
  * sources/   — static_token, github_app, atlassian_oauth, datadog_keys
  * transports/— http_proxy, git_credential, whoami, token_vend

What deliberately stayed in the broker app: core/app, core/auth, core/authz,
core/default_modules, config, providers/, aws/, sandbox/, shares/, the module
registry/ — and transports/aws_permissions, which pulls the whole AWS subsystem
and so is the aws provider's implementation rather than reusable surface.
"""

from .types import (
    AuthDependency,
    Credential,
    CredentialSource,
    Identity,
    Provider,
    Transport,
)

__all__ = [
    "AuthDependency",
    "Credential",
    "CredentialSource",
    "Identity",
    "Provider",
    "Transport",
]
