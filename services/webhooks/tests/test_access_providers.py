"""The author gate on GitLab / Slack / Jira, and the startup warning.

test_access.py covers the gate itself and the GitHub handler. These providers
send no `author_association`, so their gate is the allowlist alone — which makes
two behaviors worth pinning: an UNSET list must keep them open (project/workspace
membership is the real boundary, and closing them on upgrade would mute a working
deployment), and a SET list must actually stop a non-listed author at the handler,
not merely in `classify`.
"""

from unittest.mock import AsyncMock, patch

import pytest

from webhooks import access
from webhooks.handlers import gitlab as gl
from webhooks.handlers import jira as jr
from webhooks.handlers import slack as sl


@pytest.fixture(autouse=True)
def strict_lists():
    """Close every provider to a single trusted name, so a drop is unambiguous."""
    with patch.object(access.settings, "gitlab_allow_usernames", "maintainer"), \
         patch.object(access.settings, "slack_allow_users", "UMAINTAINER"), \
         patch.object(access.settings, "jira_allow_users", "Maintainer"), \
         patch.object(access.settings, "ignore_usernames", ""), \
         patch.object(access.settings, "forward_untrusted_comments", False):
        yield


# --- GitLab -----------------------------------------------------------------

def _note(username: str, body: str = "@agent ship it"):
    return {
        "object_attributes": {
            "note": body, "noteable_type": "Issue", "discussion_id": "d1",
        },
        "user": {"username": username},
        "issue": {"title": "A bug", "iid": 7},
        "project": {"id": 1, "path_with_namespace": "chadac/scooter"},
    }


@pytest.fixture
def gitlab_spies():
    """Spy on the SPAWN, not the whole creation path.

    A handler spawns via `asyncio.create_task(_background_create_conversation(...))`,
    so patching `create_conversation` would only be reached once that task is
    scheduled — and the task also touches the database. Patching the background
    entry point keeps these tests about the gate.
    """
    with patch.object(gl, "_background_create_conversation", new=AsyncMock()) as create, \
         patch.object(gl, "send_message", new=AsyncMock(return_value=True)) as send, \
         patch.object(gl.db, "store_conversation", new=AsyncMock()), \
         patch.object(gl.db, "store_pending_message", new=AsyncMock()), \
         patch.object(gl.db, "lookup_conversation", new=AsyncMock(return_value=None)), \
         patch.object(gl.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)):
        yield create, send


@pytest.mark.asyncio
async def test_gitlab_a_non_listed_author_spawns_nothing(gitlab_spies):
    create, send = gitlab_spies
    await gl._handle_note(_note("stranger"))
    assert not create.called and not send.called


@pytest.mark.asyncio
async def test_gitlab_a_listed_author_still_works(gitlab_spies):
    create, _ = gitlab_spies
    await gl._handle_note(_note("maintainer"))
    assert create.called, "the gate must not break the normal path"


@pytest.mark.asyncio
async def test_gitlab_a_non_listed_author_cannot_reach_a_LINKED_conversation():
    # The dangerous variant: the conversation already exists, so a forward would
    # inject a stranger's text straight into a live agent's context.
    with patch.object(gl, "send_message", new=AsyncMock(return_value=True)) as send, \
         patch.object(gl.db, "lookup_conversation", new=AsyncMock(return_value="conv-1")), \
         patch.object(gl.db, "get_conversation_for_resource", new=AsyncMock(return_value="conv-1")):
        await gl._handle_note(_note("stranger"))
    assert not send.called


@pytest.mark.asyncio
async def test_gitlab_an_unset_list_leaves_the_provider_open(gitlab_spies):
    create, _ = gitlab_spies
    with patch.object(access.settings, "gitlab_allow_usernames", ""):
        await gl._handle_note(_note("anyone"))
    assert create.called, "unset list = pre-allowlist behavior, not a lockout"


@pytest.mark.asyncio
async def test_gitlab_a_denylisted_bot_cannot_trigger_by_label():
    payload = {
        "object_attributes": {"action": "update", "title": "T", "iid": 3, "description": ""},
        "labels": [{"title": "scooter"}],
        "user": {"username": "labelbot"},
        "project": {"id": 1, "path_with_namespace": "chadac/scooter"},
    }
    with patch.object(access.settings, "ignore_usernames", "labelbot"), \
         patch.object(gl.db, "store_conversation", new=AsyncMock()) as store, \
         patch.object(gl, "create_conversation", new=AsyncMock(return_value=None)):
        await gl._handle_issue(payload)
    assert not store.called, "a label loop is worse than a missed trigger"


# --- Slack ------------------------------------------------------------------

@pytest.mark.asyncio
async def test_slack_a_non_listed_user_mentioning_the_bot_gets_nothing():
    with patch.object(sl, "_background_create_conversation", new=AsyncMock()) as create, \
         patch.object(sl, "send_message", new=AsyncMock(return_value=True)) as send, \
         patch.object(sl, "_get_bot_id", new=AsyncMock(return_value="UBOT")), \
         patch.object(sl, "add_slack_reaction", new=AsyncMock()) as react, \
         patch.object(sl.db, "store_conversation", new=AsyncMock()), \
         patch.object(sl.db, "lookup_conversation", new=AsyncMock(return_value=None)), \
         patch.object(sl.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)):
        await sl._handle_mention({
            "type": "app_mention", "channel": "C1", "user": "USTRANGER",
            "ts": "100.1", "text": "<@UBOT> deploy to prod",
        })
    assert not create.called and not send.called
    assert not react.called, "no 'eyes' either — a drop must be silent, not a tease"


@pytest.mark.asyncio
async def test_slack_a_listed_user_is_unaffected():
    with patch.object(sl, "_background_create_conversation", new=AsyncMock()) as create, \
         patch.object(sl, "_get_bot_id", new=AsyncMock(return_value="UBOT")), \
         patch.object(sl, "add_slack_reaction", new=AsyncMock()), \
         patch.object(sl.db, "store_conversation", new=AsyncMock()), \
         patch.object(sl.db, "lookup_conversation", new=AsyncMock(return_value=None)), \
         patch.object(sl.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)):
        await sl._handle_mention({
            "type": "app_mention", "channel": "C1", "user": "UMAINTAINER",
            "ts": "200.1", "text": "<@UBOT> please review",
        })
    assert create.called


# --- Jira -------------------------------------------------------------------

def _jira_comment(display_name: str, account_id: str = "acct-1"):
    return {
        "webhookEvent": "comment_created",
        "comment": {
            "body": "@agent fix this",
            "author": {"displayName": display_name, "accountId": account_id},
        },
        "issue": {"key": "ENG-1", "fields": {"summary": "A bug"}},
    }


@pytest.mark.asyncio
async def test_jira_a_non_listed_commenter_spawns_nothing():
    with patch.object(jr, "_background_create_conversation", new=AsyncMock()) as create, \
         patch.object(jr, "send_message", new=AsyncMock(return_value=True)) as send, \
         patch.object(jr.db, "store_conversation", new=AsyncMock()), \
         patch.object(jr.db, "lookup_conversation", new=AsyncMock(return_value=None)), \
         patch.object(jr.db, "get_conversation_for_jira_ticket", new=AsyncMock(return_value=None)), \
         patch.object(jr.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)):
        await jr._handle_comment(_jira_comment("Stranger"))
    assert not create.called and not send.called


@pytest.mark.asyncio
async def test_jira_the_accountId_may_be_the_listed_form():
    with patch.object(access.settings, "jira_allow_users", "acct-42"), \
         patch.object(jr, "_background_create_conversation", new=AsyncMock()) as create, \
         patch.object(jr.db, "store_conversation", new=AsyncMock()), \
         patch.object(jr.db, "link_jira_ticket", new=AsyncMock()), \
         patch.object(jr.db, "lookup_conversation", new=AsyncMock(return_value=None)), \
         patch.object(jr.db, "get_conversation_for_jira_ticket", new=AsyncMock(return_value=None)), \
         patch.object(jr.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)):
        await jr._handle_comment(_jira_comment("Whoever", account_id="acct-42"))
    assert create.called


@pytest.mark.asyncio
async def test_jira_a_denylisted_actor_cannot_trigger_by_label():
    payload = {
        "webhookEvent": "jira:issue_updated",
        "changelog": {"items": [{"field": "labels", "toString": "openhands"}]},
        "user": {"displayName": "Label Bot", "accountId": "acct-bot"},
        "issue": {"key": "ENG-2", "fields": {"summary": "S", "description": ""}},
    }
    with patch.object(access.settings, "ignore_usernames", "label bot"), \
         patch.object(jr.db, "store_conversation", new=AsyncMock()) as store, \
         patch.object(jr.db, "lookup_conversation", new=AsyncMock(return_value=None)), \
         patch.object(jr.db, "get_conversation_for_jira_ticket", new=AsyncMock(return_value=None)):
        await jr._handle_issue_updated(payload)
    assert not store.called


# --- The startup warning ----------------------------------------------------

class TestStartupWarning:
    """"Open" must be a visible choice, not something discovered by a stranger."""

    def test_an_enabled_provider_with_no_gate_warns(self, caplog):
        with patch.object(access.settings, "gitlab_allow_usernames", ""):
            access.assert_provider_gated("gitlab", enabled=True)
        assert any("NO author allowlist" in r.message for r in caplog.records)

    def test_a_gated_provider_is_quiet(self, caplog):
        access.assert_provider_gated("gitlab", enabled=True)  # list set by the fixture
        assert not caplog.records

    def test_a_disabled_provider_is_not_nagged_about(self, caplog):
        with patch.object(access.settings, "gitlab_allow_usernames", ""):
            access.assert_provider_gated("gitlab", enabled=False)
        assert not caplog.records

    def test_github_is_quiet_because_associations_gate_it_by_default(self, caplog):
        access.assert_provider_gated("github", enabled=True)
        assert not caplog.records
