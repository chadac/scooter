"""A Jira message's sender is the accountId, leveled by account type and project permission, never by display name."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from scooter_contrib_jira import senders
from scooter_contrib_jira import webhooks_handler as jira_h
from scooter_webhooks_lib.sender import Level, Sender

ISSUE = {"key": "OPS-12", "fields": {"project": {"key": "OPS"}, "summary": "s"}}


def _acct(kind, aid="557058:abc", name="Alice"):
    return {"accountId": aid, "accountType": kind, "displayName": name}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("kind", "allowed", "level"),
    [
        ("atlassian", True, Level.MEMBER),
        ("atlassian", False, Level.CONTRIBUTOR),
        ("atlassian", None, Level.UNKNOWN),
        ("customer", True, Level.GUEST),
        ("app", True, Level.UNKNOWN),
        (None, True, Level.UNKNOWN),
    ],
)
async def test_levels(kind, allowed, level):
    with patch.object(senders, "can_edit_issues", AsyncMock(return_value=allowed)):
        s = await senders.sender_of(_acct(kind), ISSUE)
    assert s.level is level


@pytest.mark.asyncio
async def test_the_sender_is_the_account_id():
    with patch.object(senders, "can_edit_issues", AsyncMock(return_value=True)) as check:
        s = await senders.sender_of(_acct("atlassian"), ISSUE)
    check.assert_awaited_once_with("OPS", "557058:abc")
    assert s == Sender("jira", "557058:abc", "Alice", Level.MEMBER, display_name="Alice")


@pytest.mark.asyncio
async def test_a_customer_needs_no_lookup():
    with patch.object(senders, "can_edit_issues", AsyncMock()) as check:
        await senders.sender_of(_acct("customer"), ISSUE)
    check.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_account_id_means_no_sender():
    assert await senders.sender_of({"displayName": "Alice", "accountType": "atlassian"}, ISSUE) is None


def test_project_key_falls_back_to_the_issue_key():
    assert senders.project_key_of({"key": "ABC-1"}) == "ABC"
    assert senders.project_key_of({}) == ""


@pytest.mark.asyncio
async def test_a_forwarded_comment_carries_its_sender():
    alice = Sender("jira", "557058:abc", "Alice", Level.MEMBER)
    send = AsyncMock(return_value=jira_h.SendOutcome.DELIVERED)
    payload = {"comment": {"body": "hi", "author": _acct("atlassian")}, "issue": ISSUE}
    with patch.object(jira_h, "sender_of", AsyncMock(return_value=alice)), \
         patch.object(jira_h, "deliver_message", send), \
         patch.object(jira_h.db, "lookup_conversation", AsyncMock(return_value="conv-1")), \
         patch.object(jira_h.db, "get_conversation_for_resource", AsyncMock(return_value=None)):
        await jira_h._handle_comment(payload)
    assert send.call_args.kwargs["sender"] == alice
