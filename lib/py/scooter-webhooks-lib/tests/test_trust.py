"""Author standing, the screen call, and the once-only decline."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import httpx
import pytest

from scooter_webhooks_lib import trust
from scooter_webhooks_lib import agent_host_client as ahc
from scooter_webhooks_lib.agent_host_client import Screen


@pytest.fixture(autouse=True)
def no_link_db(monkeypatch):
    monkeypatch.delenv("CONTRIB_GITHUB_DB_NAME", raising=False)


class TestClassify:
    @pytest.mark.asyncio
    async def test_repo_standing_is_standing(self):
        assert (await trust.classify("github", "maint", repo_standing=True, trusted_users="")).standing

    @pytest.mark.asyncio
    async def test_an_outsider_has_none(self):
        who = await trust.classify("github", "stranger", repo_standing=False, trusted_users="")
        assert not who.standing and who.user_ids == ()

    @pytest.mark.asyncio
    async def test_the_allowlist_matches_case_insensitively(self):
        who = await trust.classify("github", "Renovate[bot]", repo_standing=False, trusted_users=" renovate[bot] ,x")
        assert who.standing

    @pytest.mark.asyncio
    async def test_a_linked_scooter_user_has_standing_and_is_named(self):
        with patch.object(trust, "linked_users", new=AsyncMock(return_value=["u-1"])):
            who = await trust.classify("github", "someone", repo_standing=False, trusted_users="")
        assert who.standing and who.user_ids == ("u-1",)

    @pytest.mark.asyncio
    async def test_no_link_database_means_no_linked_users(self):
        assert await trust.linked_users("github", "someone") == []

    @pytest.mark.asyncio
    async def test_an_unknown_forge_has_no_link_table(self, monkeypatch):
        monkeypatch.setenv("CONTRIB_SLACK_DB_NAME", "contrib_slack")
        assert await trust.linked_users("slack", "someone") == []


class TestScreen:
    AUTHOR = trust.Author(source="github", login="stranger", standing=False, user_ids=("u-2",))

    @pytest.mark.asyncio
    async def test_the_gate_off_delivers_without_asking(self):
        with patch.object(trust, "screen_message", new=AsyncMock()) as ask:
            got = await trust.screen("c1", self.AUTHOR, message="m", prompt="p", url="", require_approval=False)
        assert got is Screen.DELIVER and not ask.called

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "status,body,want",
        [
            (200, {"held": True, "id": "h"}, Screen.HELD),
            (200, {"held": False}, Screen.DELIVER),
            (404, {"error": "not found"}, Screen.NOT_FOUND),
            (500, {"error": "boom"}, Screen.FAILED),
        ],
    )
    async def test_the_agent_host_answer(self, monkeypatch, status, body, want):
        sent = {}

        async def fake_post(self, url, **kwargs):  # noqa: ANN001
            sent["url"], sent["json"] = url, kwargs.get("json")
            return httpx.Response(status, json=body, request=httpx.Request("POST", url))

        monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
        got = await trust.screen("c1", self.AUTHOR, message="m", prompt="p", url="u", require_approval=True)
        assert got is want
        assert sent["url"].endswith("/conversations/c1/held-messages")
        assert sent["json"] == {
            "source": "github", "author": "stranger", "standing": False, "authorUserIds": ["u-2"],
            "text": "m", "prompt": "p", "url": "u",
        }

    @pytest.mark.asyncio
    async def test_an_unreachable_agent_host_fails_closed(self, monkeypatch):
        async def fake_post(self, url, **kwargs):  # noqa: ANN001
            raise httpx.ConnectError("down")

        monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
        assert await ahc.screen_message(
            "c1", source="github", author="a", standing=False, author_user_ids=[], text="t", prompt="p",
        ) is Screen.FAILED


class TestDecline:
    @pytest.mark.asyncio
    async def test_replies_only_the_first_time(self):
        who = trust.Author(source="github", login="stranger", standing=False)
        post = AsyncMock()
        with patch.object(trust.store, "claim_outsider_reply", new=AsyncMock(side_effect=[True, False])) as claim:
            await trust.decline_mention(who, "issue", "acme/app#1", "acme/app", post)
            await trust.decline_mention(who, "issue", "acme/app#1", "acme/app", post)
        post.assert_awaited_once_with(trust.DECLINE_REPLY)
        assert claim.call_args.args == ("github", "issue", "acme/app#1")
