"""The stored link shape ("pr"|"issue", <html_url>) must resolve from the handler's ("pull_request"|"issue", "owner/repo#N") terms."""

from scooter_contrib_github.webhooks_handler import _link_variants


def test_pull_request_offers_the_stored_pr_url():
    assert (
        "pr",
        "https://github.com/chadac-me/scooter/pull/474",
    ) in _link_variants("pull_request", "chadac-me/scooter#474")


def test_issue_offers_the_stored_issue_url():
    assert (
        "issue",
        "https://github.com/chadac-me/scooter/issues/443",
    ) in _link_variants("issue", "chadac-me/scooter#443")


def test_native_shape_is_tried_first():
    assert _link_variants("pull_request", "chadac-me/scooter#1")[0] == (
        "pull_request",
        "chadac-me/scooter#1",
    )


def test_unparseable_id_yields_no_invented_url():
    # The type is still tried in both spellings; only the id may not be invented.
    variants = _link_variants("pull_request", "not-a-resource-id")
    assert {rid for _, rid in variants} == {"not-a-resource-id"}
    assert variants[0] == ("pull_request", "not-a-resource-id")
