"""Jira's resource shapes — moved here with the provider (PR #582).

A browse URL and a bare issue key name the same issue; a bare key cannot be
widened, because the site is not in `ENG-42` and guessing one would point at
another tenant's issue.
"""

from __future__ import annotations

import scooter_contrib_jira.resources  # noqa: F401  (registers the shapes)
from scooter_webhooks_lib.resources import (
    canonical_link,
    canonical_resource_type,
    link_variants,
    resource_id_variants,
)


def test_browse_url_offers_the_issue_key():
    assert "ENG-42" in resource_id_variants(
        "jira", "issue", "https://acme.atlassian.net/browse/ENG-42"
    )


def test_the_key_is_upper_cased_from_a_url():
    # Jira keys are case-insensitive in URLs but stored upper — a lowercase link
    # must still resolve to the same ticket.
    assert "ENG-42" in resource_id_variants(
        "jira", "issue", "https://acme.atlassian.net/browse/eng-42"
    )


def test_a_bare_key_stays_itself():
    assert resource_id_variants("jira", "issue", "ENG-9") == ["ENG-9"]
    assert canonical_link("jira", "ticket", "ENG-9") == ("issue", "ENG-9")


def test_type_aliases_are_two_way():
    assert canonical_resource_type("jira", "ticket") == "issue"
    pairs = link_variants("jira", "ticket", "ENG-9")
    assert pairs[0] == ("ticket", "ENG-9")  # the caller's own shape first
    assert ("issue", "ENG-9") in pairs
