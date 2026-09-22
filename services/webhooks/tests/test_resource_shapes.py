"""The in-tree providers' shapes: the two shapes of one resource must resolve to each other.

`conversation_map` holds ("pull_request", "chadac/scooter#487"); `resource_links`
holds ("pr", "https://github.com/chadac/scooter/pull/487") — the same PR. An
exact-match lookup in either shape found nothing written in the other, so forwards
were dropped and the agent's reply tools were never armed (issue #563).
"""

import webhooks.resource_shapes  # noqa: F401  (registers the shapes under test)
from scooter_webhooks_lib.resources import (
    canonical_link,
    canonical_resource_type,
    link_variants,
    resource_id_variants,
)


def test_github_short_id_offers_the_stored_url():
    assert (
        "pr",
        "https://github.com/chadac/scooter/pull/474",
    ) in link_variants("github", "pull_request", "chadac/scooter#474")


def test_github_url_offers_the_short_id():
    assert (
        "pull_request",
        "chadac/scooter#474",
    ) in link_variants("github", "pr", "https://github.com/chadac/scooter/pull/474")


def test_issue_urls_use_the_issues_path_not_pull():
    assert "https://github.com/o/r/issues/3" in resource_id_variants("github", "issue", "o/r#3")


def test_the_callers_own_shape_is_tried_first():
    # A row written in this service's terms must still win without a rewrite.
    assert link_variants("github", "pull_request", "chadac/scooter#1")[0] == (
        "pull_request",
        "chadac/scooter#1",
    )


def test_an_unparseable_id_invents_no_url():
    # No guessing: an id that names nothing known must not resolve to someone
    # else's resource — the agent stays quiet instead.
    ids = resource_id_variants("github", "pull_request", "not-a-resource-id")
    assert ids == ["not-a-resource-id"]


def test_type_aliases_are_two_way():
    assert canonical_resource_type("github", "pr") == "pull_request"
    # An unknown type passes through rather than being mangled into a wrong one.
    assert canonical_resource_type("github", "discussion") == "discussion"


def test_canonical_link_stores_the_long_type_and_the_url():
    # URL form is what resource_links already (almost entirely) holds, and the long
    # type is what conversation_map holds + what the UI renders.
    assert canonical_link("github", "pr", "chadac/scooter#7") == (
        "pull_request",
        "https://github.com/chadac/scooter/pull/7",
    )


def test_canonical_link_keeps_an_id_it_cannot_widen():
    # An id that parses as nothing known keeps its own form: the long type still
    # applies, but no URL is invented for it.
    assert canonical_link("github", "pr", "not-an-id") == ("pull_request", "not-an-id")
