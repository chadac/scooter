"""The in-tree providers' shapes: the two shapes of one resource must resolve to each other.

`conversation_map` holds ("issue", "ENG-42"); `resource_links` holds
("ticket", the browse URL) — the same issue. An exact-match lookup in either shape
found nothing written in the other, so forwards were dropped and the agent's reply
tools were never armed (issue #563).

The github cases moved to contrib/github with the provider (PR #XXX); what is left
is what this module still registers.
"""

import webhooks.resource_shapes  # noqa: F401  (registers the shapes under test)
from scooter_webhooks_lib.resources import (
    canonical_link,
    canonical_resource_type,
    link_variants,
    resource_id_variants,
)


def test_jira_browse_url_offers_the_issue_key():
    assert "ENG-42" in resource_id_variants(
        "jira", "issue", "https://acme.atlassian.net/browse/ENG-42"
    )


def test_the_callers_own_shape_is_tried_first():
    # A row written in this service's terms must still win without a rewrite.
    assert link_variants("jira", "ticket", "ENG-1")[0] == ("ticket", "ENG-1")


def test_an_unparseable_id_invents_no_url():
    # No guessing: an id that names nothing known must not resolve to someone
    # else's resource — the agent stays quiet instead.
    assert resource_id_variants("jira", "issue", "not-a-resource-id") == ["not-a-resource-id"]


def test_type_aliases_are_two_way():
    assert canonical_resource_type("jira", "ticket") == "issue"
    # An unknown type passes through rather than being mangled into a wrong one.
    assert canonical_resource_type("jira", "epic") == "epic"


def test_canonical_link_keeps_an_id_it_cannot_widen():
    # No jira site base for a bare key: leave it be rather than invent a tenant.
    assert canonical_link("jira", "ticket", "ENG-9") == ("issue", "ENG-9")
