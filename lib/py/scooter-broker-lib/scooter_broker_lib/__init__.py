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
  * sources/   — static_token (generic; five providers compose it)
  * transports/— http_proxy, git_credential, whoami, token_vend
  * authz      — the Authorizer protocol + NoopAuthorizer + user_object: the
                 CONTRACT a provider is authorized against (the OpenFGA impl stays
                 in the app, which hands the built authorizer over)
  * context    — BrokerContext: what the broker HANDS a factory that asks for it
                 (authorizer, store_config) — substrate a provider must not build
  * store      — StoreConfig + open_sessions: the shared-broker DSN and the ONE
                 guarded async engine every store (aws, registry, shares, a
                 contrib's) is built from

THE TEST FOR WHAT BELONGS HERE: could a SECOND integration plausibly compose it?
If only its own can, it is that integration's implementation and it stays with
the provider, so it travels into that provider's contrib module rather than
stranding integration-specific code in the shared lib. That is why
`github_app`, `atlassian_oauth` and `datadog_keys` are in `broker/sources/` and
not here, and why this package needs no crypto dependency. `store` passes that
test loudly: three stores composed it before a contrib existed.

What deliberately stayed in the broker app: core/app, core/auth, the OpenFGA
AUTHORIZER itself (core/authz — implementation and SDK, not the contract),
core/default_modules, config, providers/, the provider-specific sources/, aws/,
sandbox/, shares/, the module registry/ — and transports/aws_permissions, which
pulls the whole AWS subsystem and so is the aws provider's implementation rather
than reusable surface.
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
