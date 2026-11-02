"""A Sender carries only a stable id and a contrib-assignable level to the agent-host."""

import pytest

from scooter_webhooks_lib.sender import Level, Sender, closest


def test_payload_round_trips():
    s = Sender("github", "29139614", "renovate[bot]", Level.MEMBER, display_name="Renovate")
    assert s.to_payload() == {
        "provider": "github",
        "externalId": "29139614",
        "handle": "renovate[bot]",
        "level": 40,
        "displayName": "Renovate",
    }
    assert Sender.from_payload(s.to_payload()) == s


def test_payload_omits_an_empty_display_name():
    assert "displayName" not in Sender("slack", "T1:U1", "alice").to_payload()


@pytest.mark.parametrize("level", [Level.SELF, Level.VOUCHED])
def test_a_contrib_cannot_claim_self_or_vouched(level):
    with pytest.raises(ValueError):
        Sender("github", "1", "alice", level)


def test_a_sender_needs_a_stable_id_and_a_known_provider():
    with pytest.raises(ValueError):
        Sender("github", "", "alice")
    with pytest.raises(ValueError):
        Sender("scooter", "user-1", "alice")


def test_the_default_level_is_unknown():
    assert Sender("jira", "557058:abc", "alice").level is Level.UNKNOWN


def test_closest_takes_the_lowest_level_and_defaults_to_unknown():
    assert closest(Level.GUEST, Level.MEMBER, Level.UNKNOWN) is Level.MEMBER
    assert closest() is Level.UNKNOWN


def test_a_queued_message_keeps_its_sender_and_drops_an_unreadable_one():
    from scooter_webhooks_lib.store import _stored_sender

    s = Sender("gitlab", "42", "alice", Level.GUEST)
    assert _stored_sender(s.to_payload()) == s
    assert _stored_sender(None) is None
    assert _stored_sender({"provider": "github"}) is None
    assert _stored_sender({**s.to_payload(), "level": 0}) is None
