"""gitlab uses jira's key grammar, not its own copy.

A contrib depending on another contrib is allowed — integrations reference each
other. What must stay true is that the dependency is on jira's PURE-TEXT module,
so gitlab does not reach into jira's handler, settings or store. Why: PR #583.
"""

from __future__ import annotations

from scooter_contrib_gitlab import webhooks_handler as gitlab_h


def test_gitlab_uses_jiras_extractor():
    from scooter_contrib_jira.issue_keys import extract_issue_keys

    assert gitlab_h.extract_issue_keys is extract_issue_keys


def test_gitlab_carries_no_jira_regex_of_its_own():
    # The duplicate is what this PR removed: two copies of the same grammar, one of
    # which would eventually stop matching the other.
    source = __import__("inspect").getsource(gitlab_h)
    assert "JIRA_KEY_RE" not in source


def test_the_dependency_is_the_text_module_only():
    # Importing gitlab's handler must not pull jira's ROUTER in as a side effect:
    # a deployment that ships gitlab gets jira's grammar, and jira's handler only
    # because the distribution declares its own entry point (inert unless enabled).
    import sys

    assert "scooter_contrib_jira.issue_keys" in sys.modules
    assert "scooter_contrib_jira.webhooks_handler" not in sys.modules
