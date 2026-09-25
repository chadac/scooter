"""The stored link shape must resolve.

Links are written by the agent through agent-host's /links as
("pr"|"issue", <html_url>); this handler asks in ("pull_request"|"issue",
"owner/repo#N") terms. Every other test in this suite mocks the lookup, so an
exact-match miss between those two shapes passed CI while dropping every
linked-PR forward in production. These assert the mapping itself.

Moved here with the handler (PR #591).
"""

from scooter_contrib_github.webhooks_handler import _link_variants


def test_pull_request_offers_the_stored_pr_url():
    assert (
        "pr",
        "https://github.com/chadac/scooter/pull/474",
    ) in _link_variants("pull_request", "chadac/scooter#474")


def test_issue_offers_the_stored_issue_url():
    assert (
        "issue",
        "https://github.com/chadac/scooter/issues/443",
    ) in _link_variants("issue", "chadac/scooter#443")


def test_native_shape_is_tried_first():
    # A row written in the handler's own terms must still win without a rewrite.
    assert _link_variants("pull_request", "chadac/scooter#1")[0] == (
        "pull_request",
        "chadac/scooter#1",
    )


def test_unparseable_id_yields_no_invented_url():
    # No guessing: an id that is not owner/repo#N gets no invented URL, so an
    # unlinked resource still resolves to nothing and the agent stays quiet. (The
    # type is still tried in both spellings — a "pr" row naming the same id IS this
    # resource; only the id may not be invented.)
    variants = _link_variants("pull_request", "not-a-resource-id")
    assert {rid for _, rid in variants} == {"not-a-resource-id"}
    assert variants[0] == ("pull_request", "not-a-resource-id")
