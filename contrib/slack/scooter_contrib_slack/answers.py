"""Answer buttons on a pending-question message, shared by the poster and the click handler.

Each button's value carries everything the click needs, so the webhooks half answers
without remembering what was posted: the conversation, the interrupt, the option, and
for an AskUserQuestion the question and its picked label.
"""

from __future__ import annotations

import json
from typing import Any

ASK_USER_KIND = "ask-user.questions"
BLOCK_ID = "scooter-answer"
# Slack's limits: section text 3000, button text 75, button value 2000, 25 per actions block.
SECTION_MAX = 3000
_BUTTON_TEXT_MAX = 75
_VALUE_MAX = 2000
_BUTTONS_MAX = 25


def questions_of(data: Any) -> list[dict]:
    raw = data.get("questions") if isinstance(data, dict) else None
    return [q for q in raw if isinstance(q, dict) and q.get("question")] if isinstance(raw, list) else []


def _choices(notice: dict) -> list[tuple[str, dict]] | None:
    """(label, value) per button, or None when the wait cannot be answered with one click."""
    interrupt = notice.get("interrupt") or {}
    base = {"c": notice.get("conversationId"), "i": interrupt.get("id")}
    options = [o for o in interrupt.get("options") or [] if isinstance(o, dict) and o.get("optionId")]
    if not base["c"] or not base["i"] or not options:
        return None
    if interrupt.get("kind") == ASK_USER_KIND:
        questions = questions_of(interrupt.get("data"))
        # Several questions or a multi-pick need the UI's card.
        if len(questions) != 1 or questions[0].get("multiSelect"):
            return None
        q = questions[0]
        labels = [o["label"] for o in q.get("options") or [] if isinstance(o, dict) and o.get("label")]
        # The UI's card answers a question with the first option, carrying the picks as its result.
        return [(label, {**base, "o": options[0]["optionId"], "q": q["question"], "a": label}) for label in labels] or None
    if interrupt.get("kind"):
        return None  # a contrib-rendered request whose result only its card can build
    return [(o.get("name") or o["optionId"], {**base, "o": o["optionId"]}) for o in options]


def answer_blocks(notice: dict, text: str) -> list[dict] | None:
    """The message's blocks: the question, then one button per answer; None to post text alone."""
    choices = _choices(notice)
    if not choices or len(choices) > _BUTTONS_MAX:
        return None
    buttons = []
    for n, (label, value) in enumerate(choices):
        encoded = json.dumps(value, separators=(",", ":"))
        if len(encoded) > _VALUE_MAX:
            return None
        buttons.append({
            "type": "button",
            "action_id": f"{BLOCK_ID}-{n}",
            "text": {"type": "plain_text", "text": label[:_BUTTON_TEXT_MAX], "emoji": True},
            "value": encoded,
        })
    return [
        {"type": "section", "text": {"type": "mrkdwn", "text": text[:SECTION_MAX]}},
        {"type": "actions", "block_id": BLOCK_ID, "elements": buttons},
    ]


def parse_value(raw: str) -> dict | None:
    """A clicked button's value, or None when it is not one of ours."""
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(value, dict) or not all(isinstance(value.get(k), str) and value[k] for k in ("c", "i", "o")):
        return None
    return value


def answered_blocks(original: list[dict], user_id: str, label: str) -> list[dict]:
    """The message after an answer: the question kept, the buttons replaced by who answered what."""
    kept = [b for b in original if b.get("block_id") != BLOCK_ID]
    note = f":white_check_mark: <@{user_id}> answered: *{escape(label)}*"
    return [*kept, {"type": "context", "elements": [{"type": "mrkdwn", "text": note}]}]


def escape(text: Any) -> str:
    """Slack's three control characters, so agent text cannot forge links or mentions."""
    return str(text or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
