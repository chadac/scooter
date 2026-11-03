"""A Slack answer click answers as the clicker, and only through a signed delivery."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch
from urllib.parse import urlencode

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_contrib_slack import webhooks_handler as slack_h
from scooter_contrib_slack.answers import BLOCK_ID

RESPONSE_URL = "https://hooks.slack.com/actions/T1/1/abc"
VALUE = {"c": "conv-1", "i": "i1", "o": "answer", "q": "Which database?", "a": "Postgres"}


def _payload(value: dict | None = None, **over) -> dict:
    return {
        "type": "block_actions",
        "user": {"id": "U1"},
        "response_url": RESPONSE_URL,
        "message": {"blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": "q"}},
                               {"type": "actions", "block_id": BLOCK_ID, "elements": []}]},
        "actions": [{"block_id": BLOCK_ID, "action_id": f"{BLOCK_ID}-0", "value": json.dumps(value or VALUE),
                     "text": {"type": "plain_text", "text": "Postgres"}}],
        **over,
    }


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(slack_h.router)
    return TestClient(app)


def _post(client, payload: dict):
    return client.post("/webhooks/slack/interactive", content=urlencode({"payload": json.dumps(payload)}),
                       headers={"content-type": "application/x-www-form-urlencoded"})


def test_an_unsigned_click_is_refused(client):
    with patch.object(slack_h, "settings") as s, patch.object(slack_h, "_answer_from_click", new=AsyncMock()) as answer:
        s.slack_enabled = True
        s.slack_signing_secret = "secret"
        assert _post(client, _payload()).status_code == 401
        answer.assert_not_called()


def test_a_signed_click_is_answered_off_the_request(client):
    with (
        patch.object(slack_h, "settings") as s,
        patch.object(slack_h, "_verify_slack_signature", return_value=True),
        patch.object(slack_h, "_answer_from_click", new=AsyncMock()) as answer,
    ):
        s.slack_enabled = True
        assert _post(client, _payload()).json() == {"status": "ok"}
        assert _post(client, _payload(type="view_submission")).json() == {"status": "ignored"}
        assert answer.await_count == 1


async def _click(*, owner: str | None, refusal: str | None = None, value: dict | None = None):
    payload = _payload(value)
    with (
        patch.object(slack_h, "get_user_email", new=AsyncMock(return_value="u@example.com")),
        patch.object(slack_h, "user_id_for_email", new=AsyncMock(return_value=owner)),
        patch.object(slack_h, "answer_interrupt", new=AsyncMock(return_value=refusal)) as answer,
        patch.object(slack_h, "_respond", new=AsyncMock()) as respond,
    ):
        await slack_h._answer_from_click(payload, payload["actions"][0])
    return answer, respond


async def test_a_click_answers_as_the_clickers_scooter_user():
    answer, respond = await _click(owner="u-1")
    answer.assert_awaited_once_with("conv-1", "i1", answered_by="u-1", email="u@example.com", option_id="answer",
                                    result={"answers": {"Which database?": "Postgres"}})
    url, body = respond.await_args.args
    assert url == RESPONSE_URL and body["replace_original"] is True
    assert [b["type"] for b in body["blocks"]] == ["section", "context"]


async def test_an_approval_click_carries_no_result():
    answer, _ = await _click(owner="u-1", value={"c": "conv-1", "i": "p1", "o": "allow"})
    assert answer.await_args.kwargs == {"answered_by": "u-1", "email": "u@example.com", "option_id": "allow", "result": None}


async def test_an_unmatched_slack_user_is_told_privately():
    answer, respond = await _click(owner=None)
    answer.assert_not_called()
    body = respond.await_args.args[1]
    assert body["response_type"] == "ephemeral" and body["replace_original"] is False


async def test_a_refused_answer_keeps_the_buttons():
    _, respond = await _click(owner="u-2", refusal="only the conversation's owner can answer")
    body = respond.await_args.args[1]
    assert body["replace_original"] is False
    assert "only the conversation's owner can answer" in body["text"]
