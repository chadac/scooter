"""Trigger policy — the rules four handlers each had their own copy of.

These were byte-identical private functions in github/gitlab/jira/slack, so a fix
to one silently left three behind, and a contrib handler couldn't reach any of them
without importing the webhooks app. Why: PR #577.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from scooter_webhooks_lib import policy


@dataclass
class StubConfig:
    mention_pattern: str = "@agent"
    label_trigger: str = "scooter"
    ignore_usernames: str = ""
    ignore_bot_authors: bool = True
    descriptions: dict[str, str] = field(default_factory=dict)

    def get_repo_descriptions(self) -> dict[str, str]:
        return self.descriptions


@pytest.fixture
def cfg():
    c = StubConfig()
    policy.init(c)
    return c


def test_mentions_are_case_insensitive(cfg):
    assert policy.mentions_agent("hey @AGENT please look")
    assert policy.mentions_agent("@agent")
    assert not policy.mentions_agent("no mention here")
    assert not policy.mentions_agent("")


def test_strip_mention_leaves_the_message(cfg):
    assert policy.strip_mention("@agent  fix the flake  ") == "fix the flake"
    # Nothing to strip is not an error — the text forwards unchanged.
    assert policy.strip_mention("fix the flake") == "fix the flake"


def test_trigger_label_is_case_insensitive(cfg):
    assert policy.is_trigger_label("Scooter")
    assert not policy.is_trigger_label("bug")
    assert not policy.is_trigger_label("")


def test_ignored_users_match_case_insensitively_and_ignore_spacing(cfg):
    cfg.ignore_usernames = " Scooter-Chadac-Me[bot] , noisy "
    assert policy.is_ignored_user("scooter-chadac-me[BOT]")
    assert policy.is_ignored_user("noisy")
    assert not policy.is_ignored_user("alice")


def test_an_empty_drop_list_ignores_nobody(cfg):
    # Including the empty username: a blank entry must not become a wildcard.
    cfg.ignore_usernames = ""
    assert not policy.is_ignored_user("alice")
    assert not policy.is_ignored_user("")


def test_a_list_of_only_separators_ignores_nobody(cfg):
    cfg.ignore_usernames = " , , "
    assert not policy.is_ignored_user("")
    assert not policy.is_ignored_user("alice")


def test_the_drop_list_is_re_read_when_it_changes(cfg):
    # Parsed per distinct value, so a settings change at runtime takes effect —
    # snapshotting it at init() would silently keep the old list.
    assert not policy.is_ignored_user("noisy")
    cfg.ignore_usernames = "noisy"
    assert policy.is_ignored_user("noisy")
    cfg.ignore_usernames = ""
    assert not policy.is_ignored_user("noisy")


def test_repo_context_is_empty_when_undescribed(cfg):
    assert policy.repo_context("acme/web") == ""
    cfg.descriptions = {"acme/web": "the storefront"}
    assert policy.repo_context("acme/web") == "\nRepo description: the storefront\n"
    assert policy.repo_description("acme/web") == "the storefront"


def test_own_ack_matches_current_and_legacy_markers(cfg):
    assert policy.is_own_ack("Scooter is on it — conversation ...")
    assert policy.is_own_ack("OpenHands is working on this.")
    assert policy.is_own_ack("...\nOpenHands status: running")
    assert not policy.is_own_ack("Scooter should look at this")


def test_policy_refuses_to_answer_unconfigured(monkeypatch):
    monkeypatch.setattr(policy, "_config", None)
    with pytest.raises(RuntimeError, match="init"):
        policy.mentions_agent("@agent")
