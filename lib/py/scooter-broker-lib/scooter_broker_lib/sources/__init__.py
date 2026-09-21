"""GENERIC credential sources — how a provider obtains its secret.

Implements the `CredentialSource` protocol from `..types`. Only mechanisms that
more than one integration can plausibly compose belong here: `static_token` is
used by five providers today.

Provider-specific sources do NOT live here — a GitHub App token minter is github
implementation, not shared surface, and keeping it here would leave
github-specific code in the shared lib after github becomes a contrib. Those sit
with their provider in `broker/sources/` and move into its contrib with it.
See PR #567.
"""
