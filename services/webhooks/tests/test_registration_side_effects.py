"""Importing the app must arm owner resolution.

The resolvers are registered by IMPORT SIDE EFFECT, and after the split nothing
else imports `webhooks.identity_resolve`. Drop that one line from `app.py` and
every webhook-spawned conversation silently becomes unowned — no error, no log,
just a feature that stopped. This is the test that fails instead. Why: PR #575.
"""

from __future__ import annotations

from scooter_webhooks_lib import identity, resources


def test_importing_the_app_registers_every_in_tree_resolver():
    import webhooks.app  # noqa: F401

    assert identity.registered_providers() == ["github", "gitlab", "slack"]


def test_importing_the_app_registers_every_in_tree_resource_shape():
    # Same hazard as the resolvers, different failure: without the shapes, a link
    # written as a URL stops matching the short form the webhook arrives with, and
    # forwards silently drop again (issue #563). Why: PR #576.
    import webhooks.app  # noqa: F401

    assert resources.registered_sources() == ["github", "gitlab", "jira", "slack"]
