"""Which waits get answer buttons, and what a click carries back."""

from __future__ import annotations

import json

from scooter_contrib_slack import answers

Q = {"question": "Which database?", "options": [{"label": "Postgres"}, {"label": "SQLite"}]}


def _notice(interrupt: dict) -> dict:
    return {"conversationId": "conv-1", "interrupt": {"id": "i1", **interrupt}}


def _ask(*questions: dict) -> dict:
    return _notice({"kind": answers.ASK_USER_KIND, "data": {"questions": list(questions)},
                    "options": [{"optionId": "answer", "name": "Answer"}]})


def _values(blocks):
    return [json.loads(b["value"]) for b in blocks[1]["elements"]]


def test_an_approval_gets_a_button_per_option():
    blocks = answers.answer_blocks(_notice({"options": [{"optionId": "allow", "name": "Allow once"},
                                                        {"optionId": "deny", "name": "Deny"}]}), "text")
    assert [b["text"]["text"] for b in blocks[1]["elements"]] == ["Allow once", "Deny"]
    assert _values(blocks) == [{"c": "conv-1", "i": "i1", "o": "allow"}, {"c": "conv-1", "i": "i1", "o": "deny"}]


def test_waits_a_click_cannot_answer_post_text_alone():
    assert answers.answer_blocks(_ask(Q, {**Q, "question": "Which cache?"}), "t") is None
    assert answers.answer_blocks(_ask({**Q, "multiSelect": True}), "t") is None
    assert answers.answer_blocks(_notice({"kind": "aws.access", "options": [{"optionId": "ok"}]}), "t") is None
    assert answers.answer_blocks(_notice({"options": []}), "t") is None


def test_an_oversized_value_posts_text_alone():
    assert answers.answer_blocks(_ask({**Q, "question": "x" * 2100}), "t") is None


def test_parse_value_rejects_foreign_buttons():
    assert answers.parse_value('{"c":"conv-1","i":"i1","o":"allow"}') == {"c": "conv-1", "i": "i1", "o": "allow"}
    assert answers.parse_value("not json") is None
    assert answers.parse_value('{"c":"conv-1"}') is None


def test_answered_blocks_replace_the_buttons():
    original = answers.answer_blocks(_ask(Q), "the question")
    after = answers.answered_blocks(original, "U1", "<Postgres>")
    assert [b["type"] for b in after] == ["section", "context"]
    assert after[1]["elements"][0]["text"] == ":white_check_mark: <@U1> answered: *&lt;Postgres&gt;*"
