"""GENERIC credential sources — how a provider obtains its secret.

Implements the `CredentialSource` protocol from `..types`. Only mechanisms that
more than one integration can plausibly compose belong here: `static_token` is
used by five providers today.

Provider-specific sources do NOT live here — a GitHub App token minter is github
implementation, not shared surface. Each one now sits in its provider's contrib
(`contrib/github/`, `contrib/jira/`, `contrib/datadog/`), which is why this
package needs no crypto dependency. See PR #567.
"""
