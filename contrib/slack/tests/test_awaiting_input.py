"""A pending question reaches the conversation's Slack thread, from the agent-host only."""

from __future__ import annotations

import json

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_slack import awaiting_input as ai

QUESTIONS = {
    "questions": [
        {
            "header": "DB",
            "question": "Which database?",
            "options": [{"label": "Postgres", "description": "the default"}, {"label": "SQLite"}],
        },
    ]
}


def _notice(**over) -> dict:
    return {
        "conversationId": "conv-1",
        "conversationUrl": "https://scooter.example/?thread=conv-1",
        "links": [{"source": "slack", "resourceType": "thread", "ref": {"channel": "C1", "threadTs": "17.5"}}],
        "interrupt": {
            "id": "q1",
            "message": "The agent has a question",
            "kind": "ask-user.questions",
            "data": QUESTIONS,
            "options": [{"optionId": "answer", "name": "Answer"}],
        },
        **over,
    }


def test_format_lists_each_question_and_its_options():
    text = ai.format_notice(_notice())
    assert text.startswith(":question: I have a question")
    assert "*DB:* Which database?" in text
    assert "• Postgres — the default" in text
    assert "• SQLite" in text
    assert text.endswith("<https://scooter.example/?thread=conv-1|Answer in Scooter>")


def test_format_falls_back_to_the_message_and_choices():
    notice = _notice(interrupt={
        "id": "p1", "message": "Allow the agent to run `rm`?",
        "options": [{"optionId": "allow", "name": "Allow once"}, {"optionId": "deny", "name": "Deny"}],
    })
    text = ai.format_notice(notice)
    assert "Allow the agent to run `rm`?" in text
    assert "Choices: Allow once / Deny" in text


def test_format_escapes_slack_control_characters():
    notice = _notice(interrupt={"id": "x", "message": "<!channel> & <https://evil|click>", "options": []})
    text = ai.format_notice(notice)
    assert "<!channel>" not in text and "&lt;!channel&gt; &amp;" in text


def _client(monkeypatch, *, approver: bool = True, slack_reply: dict | None = None):
    sent: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(req)
        return httpx.Response(200, json=slack_reply or {"ok": True, "ts": "18.0"})

    real = httpx.AsyncClient
    monkeypatch.setattr(ai.httpx, "AsyncClient", lambda *a, **kw: real(*a, transport=httpx.MockTransport(handler), **kw))

    transport = ai.AwaitingInputNotice()
    provider = Provider(name="slack", credential=StaticTokenSource(token="xoxb-1"), transports=[transport])
    sa = "system:serviceaccount:agent-sandbox:" + ("agent-host" if approver else "sandbox-conv-1")

    async def authed() -> Identity:
        return Identity("" if approver else "conv-1", "agent-sandbox", sa, is_approver=approver)

    app = FastAPI()
    app.include_router(transport.routes(provider, authed), prefix="/slack")
    return TestClient(app), sent


def test_posts_the_question_into_the_thread(monkeypatch):
    client, sent = _client(monkeypatch)
    r = client.post("/slack/awaiting-input", json=_notice())
    assert r.status_code == 200 and r.json() == {"posted": True, "ts": "18.0"}
    assert len(sent) == 1
    assert str(sent[0].url) == "https://slack.com/api/chat.postMessage"
    assert sent[0].headers["Authorization"] == "Bearer xoxb-1"
    body = json.loads(sent[0].content)
    assert body["channel"] == "C1" and body["thread_ts"] == "17.5"
    assert "Which database?" in body["text"]


def test_no_slack_link_posts_nothing(monkeypatch):
    client, sent = _client(monkeypatch)
    r = client.post("/slack/awaiting-input", json=_notice(links=[{"source": "github", "ref": {}}]))
    assert r.status_code == 200 and r.json()["posted"] is False
    assert sent == []


def test_a_sandbox_cannot_post_as_the_bot(monkeypatch):
    client, sent = _client(monkeypatch, approver=False)
    assert client.post("/slack/awaiting-input", json=_notice()).status_code == 403
    assert sent == []


def test_a_slack_refusal_is_reported(monkeypatch):
    client, _ = _client(monkeypatch, slack_reply={"ok": False, "error": "channel_not_found"})
    r = client.post("/slack/awaiting-input", json=_notice())
    assert r.status_code == 502 and "channel_not_found" in r.text


def test_a_single_question_posts_one_button_per_option(monkeypatch):
    client, sent = _client(monkeypatch)
    client.post("/slack/awaiting-input", json=_notice())
    blocks = json.loads(sent[0].content)["blocks"]
    assert blocks[0]["text"]["text"].startswith(":question:")
    buttons = blocks[1]["elements"]
    assert [b["text"]["text"] for b in buttons] == ["Postgres", "SQLite"]
    assert json.loads(buttons[0]["value"]) == {"c": "conv-1", "i": "q1", "o": "answer", "q": "Which database?", "a": "Postgres"}
