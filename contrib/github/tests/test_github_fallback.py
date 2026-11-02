"""A comment on a linked PR replaces its conversation only when that conversation no longer exists (issue #802)."""

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from scooter_contrib_github import webhooks_handler as gh


def _comment(body="please also fix the docs"):
    return {
        "action": "created",
        "comment": {"id": 1, "body": body, "user": {"login": "chadac"}},
        "issue": {"number": 799, "title": "Some PR", "pull_request": {"url": "u"}},
        "repository": {"owner": {"login": "chadac-me"}, "name": "scooter"},
    }


@pytest.fixture
def linked():
    """PR #799 is mapped to conv-old; yields (deliver, store_conversation, background_create)."""
    deliver = AsyncMock()
    store = AsyncMock()
    create = AsyncMock()
    with patch.object(gh, "deliver_message", new=deliver), \
         patch.object(gh, "get_app_login", new=AsyncMock(return_value=None)), \
         patch.object(gh, "_background_create_conversation", new=create), \
         patch.object(gh.db, "lookup_conversation", new=AsyncMock(return_value="conv-old")), \
         patch.object(gh.db, "get_conversation_for_resource", new=AsyncMock(return_value=None)), \
         patch.object(gh.db, "store_conversation", new=store):
        yield deliver, store, create


@pytest.mark.parametrize(
    "outcome",
    [gh.SendOutcome.DELIVERED, gh.SendOutcome.RUN_FAILED, gh.SendOutcome.UNREACHABLE],
)
async def test_a_conversation_that_still_exists_keeps_its_mapping(linked, outcome):
    deliver, store, create = linked
    deliver.return_value = outcome
    await gh._handle_comment(_comment())
    assert deliver.await_args.args[0] == "conv-old"
    assert not store.called, "the mapping must not be overwritten"
    assert not create.called, "no memoryless replacement conversation"


async def test_a_missing_conversation_is_replaced(linked):
    deliver, store, create = linked
    deliver.return_value = gh.SendOutcome.NOT_FOUND
    await gh._handle_comment(_comment())
    store.assert_awaited_once_with(
        "github", "pull_request", "chadac-me/scooter#799", gh.PENDING_CONVERSATION_ID,
    )
    # Let the create task scheduled by the handler run.
    await asyncio.sleep(0)
    assert create.called
    assert create.await_args.kwargs["invoking_user"] == "chadac"
