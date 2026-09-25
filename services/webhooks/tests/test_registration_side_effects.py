"""Importing the app must arm owner resolution and resource shapes.

Both register by IMPORT SIDE EFFECT, and nothing else imports the modules that do
it. Drop a line from `app.py` and every webhook-spawned conversation silently
becomes unowned (#575), or a URL-form link stops matching the short form a webhook
arrives with and forwards drop again (#576, issue #563). No error, no log — these
are the tests that fail instead.

Asserted as a SUBSET, not an exact list: this suite runs in the built service, which
has whatever contribs the image ships (gitlab is one, PR #580). Pinning the exact
set would make adding a contrib fail here for no reason, and would say nothing extra
— what matters is that the app's OWN registrations happened.

The resolver half of this file is GONE, not emptied. github was the last in-tree
email resolver and it left with PR #591, so identity_resolve.py no longer exists.
`IN_TREE_RESOLVERS = set()` would still pass — a subset assertion over an empty set
is vacuously true — which is worse than no test, because it reads like coverage.
Each contrib now tests its own resolver registration (contrib/*/tests/).
"""

from __future__ import annotations

from scooter_webhooks_lib import resources

IN_TREE_SHAPES = {"jira"}


def test_importing_the_app_registers_every_in_tree_resource_shape():
    import webhooks.app  # noqa: F401

    assert IN_TREE_SHAPES <= set(resources.registered_sources())
