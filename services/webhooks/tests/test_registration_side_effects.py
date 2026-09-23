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
"""

from __future__ import annotations

from scooter_webhooks_lib import identity, resources

IN_TREE_RESOLVERS = {"github"}
IN_TREE_SHAPES = {"github"}


def test_importing_the_app_registers_every_in_tree_resolver():
    import webhooks.app  # noqa: F401

    assert IN_TREE_RESOLVERS <= set(identity.registered_providers())


def test_importing_the_app_registers_every_in_tree_resource_shape():
    import webhooks.app  # noqa: F401

    assert IN_TREE_SHAPES <= set(resources.registered_sources())
