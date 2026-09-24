"""What the broker HANDS a provider: the substrate a provider must not build itself.

A provider factory reads its own config — datadog's two keys, gitlab's token. That is
the right default and most providers need nothing else. But two things are
deployment-level rather than integration-level, shared by every provider, and wrong
for a contrib to assemble:

  * `authorizer`    — the enforcement point. A provider that builds its own could
                      build a NoopAuthorizer and authorize itself (see authz.py).
  * `store_config`  — the shared `broker` database's DSN components, which arrive as
                      separate env vars precisely so the password can come from a
                      secretKeyRef; a provider reconstructing them gets to drop one
                      (PR #621: all three in-tree stores dropped sslmode).

So the app builds these ONCE and passes them in. A factory opts in by declaring a
parameter; one that declares none is called with no arguments and never learns this
type exists — which is why adding the context changed no existing provider.

This is also the seam the fuller authz+audit layer (#190, to be re-implemented for
contribs) plugs into: a policy and an audit sink are the next two fields, and a
provider that already takes a context gains them without another signature change.
"""

from __future__ import annotations

from dataclasses import dataclass

from .authz import Authorizer
from .store import StoreConfig


@dataclass(frozen=True)
class BrokerContext:
    """Substrate the broker supplies to a provider factory that asks for it."""

    authorizer: Authorizer
    store_config: StoreConfig
