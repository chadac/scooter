"""The viewer's annotation half: anchor resolution, the outbox, and the sync state.

The viewer owns the working copy, so it is the only component that can say whether
an anchor still matches the file — and broker-ack is the point an annotation becomes
real, so these tests pin both: what the viewer refuses to store, and what it reports
while a push is in flight, retrying, abandoned, or refused by a deployment that stores
nothing.

The outbox runs on a thread in production; here `flush` is driven directly so a test
asserts on a pass rather than on a sleep.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "viewer"))

import annotations as ann  # noqa: E402
import cli  # noqa: E402


# --- fakes ----------------------------------------------------------------------


class FakeTransport:
    """A broker that records what it was handed and fails on demand."""

    def __init__(self) -> None:
        self.puts: list[dict] = []
        self.resolves: list[tuple[str, bool]] = []
        self.remote: list[dict] = []
        # Raised by the next `put`, then cleared unless `sticky`.
        self.fail: Exception | None = None
        self.sticky = False

    def put(self, payload: dict) -> dict:
        if self.fail is not None:
            error = self.fail
            if not self.sticky:
                self.fail = None
            raise error
        self.puts.append(payload)
        return {"created": True}

    def resolve(self, thread: str, resolved: bool) -> None:
        if self.fail is not None:
            error = self.fail
            if not self.sticky:
                self.fail = None
            raise error
        self.resolves.append((thread, resolved))

    def pull(self) -> list[dict]:
        return list(self.remote)


class FakeClock:
    """Monotonic time a test advances by hand, so backoff is asserted not waited on."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


DOC = "alpha\nbravo quoted text\ncharlie\ndelta quoted text\n"


@pytest.fixture
def store(tmp_path: Path):
    return ann.Annotations(
        state_path=tmp_path / "annotations.json",
        root=Path("/workspace"),
        transport=FakeTransport(),
        clock=FakeClock(),
    )


def test_the_broker_is_told_an_absolute_path_and_the_viewer_keeps_a_relative_one(store):
    store.add(content=DOC, path="docs/x.md", line=2, quote="bravo", text="a")
    store.flush()

    # The agent wakes with a path it can open; the browser keeps asking by the key
    # it already uses for every other route.
    assert store.transport.puts[0]["path"] == "/workspace/docs/x.md"
    assert next(iter(store.records.values())).path == "docs/x.md"


def test_a_pulled_path_comes_back_to_the_viewers_key(store):
    store.transport.remote = [
        {
            "id": "a1",
            "path": "/workspace/docs/x.md",
            "anchor": {"line": 2, "quote": "bravo"},
            "text": "from another viewer",
        },
        # A thread about a file this workspace does not have is kept verbatim: it
        # matches no open file, rather than being bent into one that is not it.
        {"id": "a2", "path": "/elsewhere/y.md", "anchor": {"line": 1}, "text": "other"},
    ]

    assert store.pull() == 2
    assert store.records["a1"].path == "docs/x.md"
    assert store.records["a2"].path == "/elsewhere/y.md"


# --- anchor resolution ----------------------------------------------------------


def test_anchor_trusts_the_line_when_the_quote_still_matches():
    assert ann.resolve_anchor(DOC, ann.Anchor(line=2, quote="bravo")) == (2, "ok")


def test_anchor_follows_a_quote_that_moved():
    # An edit above the anchor shifts it; the quote is the identity, so the thread
    # follows rather than pointing at whatever now sits on line 2.
    edited = "inserted\n" + DOC
    assert ann.resolve_anchor(edited, ann.Anchor(line=2, quote="bravo")) == (3, "moved")


def test_anchor_is_stale_when_the_quote_is_gone():
    # Not silently moved to a nearby line: a thread whose text no longer exists is
    # reported as stale and keeps its recorded line for ordering.
    assert ann.resolve_anchor("nothing like it\n", ann.Anchor(line=2, quote="bravo")) == (
        2,
        "stale",
    )


def test_a_repeated_quote_resolves_to_the_occurrence_nearest_the_recorded_line():
    assert ann.resolve_anchor(DOC, ann.Anchor(line=4, quote="quoted text"))[0] == 4
    assert ann.resolve_anchor(DOC, ann.Anchor(line=1, quote="quoted text"))[0] == 2


def test_a_multi_line_quote_resolves_to_its_first_line():
    assert ann.resolve_anchor(DOC, ann.Anchor(line=1, quote="bravo quoted text\ncharlie")) == (
        2,
        "moved",
    )


def test_an_empty_quote_anchors_to_the_line_alone():
    # A whole-line comment carries no quote, so the line is all there is to trust.
    assert ann.resolve_anchor(DOC, ann.Anchor(line=3, quote="")) == (3, "ok")
    assert ann.resolve_anchor(DOC, ann.Anchor(line=99, quote="")) == (99, "stale")


# --- writes ---------------------------------------------------------------------


def test_add_refuses_an_anchor_that_does_not_match_the_file(store):
    # The viewer is the only component that can check this, so it must: a comment
    # stored against a quote that is not there is unplaceable the moment it syncs.
    with pytest.raises(ann.AnchorError):
        store.add(content=DOC, path="doc.md", line=2, quote="not in the file", text="hm")


def test_add_persists_pending_and_the_flush_acks_it(store):
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="why this?")
    # Nothing is claimed as committed before the broker says so.
    assert record.state == "pending"
    assert record.thread == record.id

    store.flush()
    assert store.get(record.id).state == "acked"
    (pushed,) = store.transport.puts
    assert pushed["id"] == record.id
    assert pushed["path"] == "/workspace/doc.md"
    assert pushed["anchor"] == {"line": 2, "quote": "bravo"}
    assert pushed["kind"] == "comment"
    assert pushed["text"] == "why this?"


def test_a_reply_joins_the_thread_it_names(store):
    first = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="first")
    reply = store.add(
        content=DOC, path="doc.md", line=2, quote="bravo", text="second", thread=first.thread
    )
    assert reply.thread == first.thread
    assert reply.id != first.id


def test_an_answer_needs_the_question_it_answers(store):
    with pytest.raises(ann.AnnotationError):
        store.add(
            content=DOC, path="doc.md", line=2, quote="bravo", text="yes", kind="answer"
        )


# --- the outbox -----------------------------------------------------------------


def test_a_failed_push_retries_with_backoff_and_keeps_the_same_id(store):
    store.transport.fail = ann.TransportError("connection refused")
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")

    store.flush()
    pending = store.get(record.id)
    assert pending.state == "pending"
    assert pending.attempts == 1
    assert pending.error == "connection refused"

    # Too soon: backoff is the point, so a flush before the delay does nothing.
    store.flush()
    assert store.get(record.id).attempts == 1

    store.clock.advance(ann.BACKOFF_SECONDS * 2)
    store.flush()
    acked = store.get(record.id)
    assert acked.state == "acked"
    # One record, pushed under its original id — a retry must not duplicate a remark.
    assert [p["id"] for p in store.transport.puts] == [record.id]


def test_a_push_that_keeps_failing_is_abandoned_and_offers_a_manual_retry(store):
    store.transport.fail = ann.TransportError("nope")
    store.transport.sticky = True
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")

    for _ in range(ann.MAX_ATTEMPTS):
        store.clock.advance(ann.BACKOFF_SECONDS * 2**ann.MAX_ATTEMPTS)
        store.flush()

    failed = store.get(record.id)
    assert failed.state == "failed"
    assert failed.attempts == ann.MAX_ATTEMPTS

    # A manual retry clears the giving-up state and pushes again.
    store.transport.fail = None
    store.transport.sticky = False
    store.retry(record.id)
    store.flush()
    assert store.get(record.id).state == "acked"


def test_a_deployment_that_stores_nothing_reads_as_disabled_not_as_failure(store):
    # 404 is the absent-provider answer, so retrying it forever would be a lie about
    # a deployment that simply ships the viewer read-only.
    store.transport.fail = ann.TransportError("not found", status=404)
    store.transport.sticky = True
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")

    store.flush()
    assert store.get(record.id).state == "disabled"

    store.clock.advance(ann.BACKOFF_SECONDS * 100)
    store.flush()
    # Still one attempt: disabled is terminal until a manual retry.
    assert store.get(record.id).attempts == 1


def test_resolving_a_thread_queues_through_the_same_outbox(store):
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")
    store.flush()

    store.transport.fail = ann.TransportError("down")
    store.resolve(record.thread, True)
    assert store.get(record.id).resolved is True
    store.flush()
    assert store.transport.resolves == []

    store.clock.advance(ann.BACKOFF_SECONDS * 2)
    store.flush()
    assert store.transport.resolves == [(record.thread, True)]


# --- durability and rehydration -------------------------------------------------


def test_state_survives_a_restart(tmp_path: Path):
    path = tmp_path / "annotations.json"
    first = ann.Annotations(state_path=path, transport=FakeTransport(), clock=FakeClock())
    record = first.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")
    first.flush()

    second = ann.Annotations(state_path=path, transport=FakeTransport(), clock=FakeClock())
    assert second.get(record.id).text == "x"
    assert second.get(record.id).state == "acked"


def test_start_pulls_threads_this_viewer_never_saw(tmp_path: Path):
    transport = FakeTransport()
    transport.remote = [
        {
            "id": "remote-1",
            "path": "doc.md",
            "anchor": {"line": 2, "quote": "bravo"},
            "kind": "comment",
            "thread": "remote-1",
            "text": "from before the restart",
            "resolved": False,
            "created_at": "2026-01-01T00:00:00+00:00",
        }
    ]
    store = ann.Annotations(
        state_path=tmp_path / "annotations.json", transport=transport, clock=FakeClock()
    )
    store.pull()

    pulled = store.get("remote-1")
    assert pulled.text == "from before the restart"
    # Already in the store it came from, so it is acked, not queued for a push back.
    assert pulled.state == "acked"


def test_a_pull_does_not_clobber_a_local_record_still_in_flight(tmp_path: Path):
    transport = FakeTransport()
    transport.fail = ann.TransportError("down")
    transport.sticky = True
    store = ann.Annotations(
        state_path=tmp_path / "annotations.json", transport=transport, clock=FakeClock()
    )
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="mine")
    store.flush()

    transport.remote = [
        {
            "id": record.id,
            "path": "doc.md",
            "anchor": {"line": 2, "quote": "bravo"},
            "kind": "comment",
            "thread": record.thread,
            "text": "stale copy",
            "resolved": True,
            "created_at": "",
        }
    ]
    store.pull()
    assert store.get(record.id).text == "mine"


# --- reads ----------------------------------------------------------------------


def test_list_resolves_every_anchor_against_the_live_file(store):
    first = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="a")
    gone = store.add(content=DOC, path="doc.md", line=4, quote="delta", text="b")
    store.add(content=DOC, path="other.md", line=1, quote="", text="elsewhere")

    # The file moves on under the comments: one anchor shifts, one disappears.
    edited = "inserted\nalpha\nbravo quoted text\ncharlie\n"
    listed = store.list(path="doc.md", content=edited)

    by_id = {r["id"]: r for r in listed}
    assert len(by_id) == 2
    assert (by_id[first.id]["line"], by_id[first.id]["anchor_state"]) == (3, "moved")
    assert by_id[gone.id]["anchor_state"] == "stale"


def test_list_without_content_reports_anchors_unresolved(store):
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="a")
    (listed,) = store.list(path="doc.md")
    # The rail lists threads for files that are not open, so there is nothing to
    # resolve against; the recorded line stands and staleness is unknown.
    assert (listed["id"], listed["line"], listed["anchor_state"]) == (record.id, 2, "unknown")


def test_counts_report_what_a_reviewer_is_blocking_on(store):
    comment = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="a")
    open_thread = store.add(content=DOC, path="doc.md", line=3, quote="charlie", text="b")
    store.resolve(comment.thread, True)

    # Unresolved discussion and un-acked syncs are different problems: one is for the
    # reader to answer, the other is the viewer admitting it has not committed yet.
    assert store.counts() == {"comments": 1, "pending": 2, "stale": 0}
    store.flush()
    assert store.counts()["pending"] == 0
    assert store.get(open_thread.id).resolved is False


def test_the_state_file_is_valid_json_a_human_can_read(store, tmp_path):
    store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")
    written = json.loads(store.state_path.read_text())
    assert written["version"] == 1
    assert written["records"][0]["text"] == "x"


# --- telling the agent ------------------------------------------------------------


class FakeNotifier:
    """The self-access listener: records each message, fails on demand."""

    def __init__(self) -> None:
        self.sent: list[str] = []
        self.fail: Exception | None = None
        self.sticky = False
        self.configured = True

    def send(self, text: str) -> None:
        if self.fail is not None:
            error = self.fail
            if not self.sticky:
                self.fail = None
            raise error
        self.sent.append(text)


@pytest.fixture
def told(tmp_path: Path):
    """A store with a notifier, and the clock its outbox runs on."""
    clock = FakeClock()
    store = ann.Annotations(
        state_path=tmp_path / "annotations.json",
        root=Path("/workspace"),
        transport=FakeTransport(),
        notifier=FakeNotifier(),
        clock=clock,
    )
    return store, clock


def _past_the_delay(clock: FakeClock) -> None:
    clock.advance(ann.NOTIFY_DELAY_SECONDS + 0.1)


def test_the_agent_is_told_only_after_the_broker_has_the_remark(told):
    store, clock = told
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="why this?")
    assert record.notify == "pending"

    # Nothing is announced before the broker has it.
    store.transport.fail = ann.TransportError("broker down", status=503)
    store.transport.sticky = True
    store.flush()
    _past_the_delay(clock)
    store.flush()
    assert store.notifier.sent == []

    store.transport.fail = None
    clock.advance(60)
    store.flush()  # the push lands
    assert store.get(record.id).state == "acked"
    assert store.notifier.sent == []  # still inside the batching delay

    _past_the_delay(clock)
    store.flush()
    (message,) = store.notifier.sent
    assert "/workspace/doc.md:2" in message
    assert "'bravo'" in message
    assert "why this?" in message
    assert "?path=doc.md" in message
    assert store.get(record.id).notify == "sent"

    # And never again.
    clock.advance(600)
    store.flush()
    assert len(store.notifier.sent) == 1


def test_a_burst_of_remarks_is_one_message(told):
    # One message per burst: one agent turn, under the rate limit.
    store, clock = told
    first = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="one")
    store.add(content=DOC, path="doc.md", line=4, quote="delta", text="two")
    store.add(content=DOC, path="doc.md", line=1, text="reply", thread=first.id)
    store.flush()
    _past_the_delay(clock)
    store.flush()

    (message,) = store.notifier.sent
    assert message.startswith("3 new review remarks")
    assert "one" in message and "two" in message
    assert f"In reply to thread {first.id}" in message
    # Ordered by position in the file.
    assert message.index(":1.") < message.index(":2.") < message.index(":4.")


def test_each_comment_says_how_to_reply_and_resolve_its_thread(told):
    store, clock = told
    first = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="one")
    store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="two", thread=first.id)
    store.flush()
    _past_the_delay(clock)
    store.flush()

    (message,) = store.notifier.sent
    # Replies hint at their thread, not their own id.
    assert message.count(f"scooter-files reply {first.id}") == 2
    assert f"scooter-files resolve {first.id}" in message


def test_an_agent_reply_lands_at_the_threads_anchor_and_wakes_no_one(told):
    store, _ = told
    first = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="why?")
    reply = store.reply(thread=first.id, text="because", content_of=lambda _: DOC)
    assert (reply.thread, reply.line, reply.quote, reply.by) == (first.id, 2, "bravo", "agent")
    assert reply.notify == ""


def test_an_agent_reply_to_edited_text_keeps_only_the_line(told):
    store, _ = told
    first = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="why?")
    reply = store.reply(thread=first.id, text="fixed", content_of=lambda _: "alpha\ngone\n")
    assert (reply.line, reply.quote) == (2, "")


def test_a_reply_to_an_unknown_thread_is_refused(told):
    store, _ = told
    with pytest.raises(ann.AnnotationError):
        store.reply(thread="nope", text="x", content_of=lambda _: DOC)


def test_a_failed_notify_backs_off_and_never_touches_the_stored_state(told):
    store, clock = told
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")
    store.flush()
    store.notifier.fail = ann.TransportError("router down", status=503)
    _past_the_delay(clock)
    store.flush()

    # A failed notify never touches the stored state.
    assert store.get(record.id).state == "acked"
    assert store.get(record.id).error == ""
    assert store.get(record.id).notify == "pending"

    clock.advance(ann.BACKOFF_SECONDS)
    store.flush()
    assert len(store.notifier.sent) == 1
    assert store.get(record.id).notify == "sent"


def test_a_rate_limited_notify_waits_as_told_without_spending_an_attempt(told):
    store, clock = told
    store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")
    store.flush()
    store.notifier.fail = ann.TransportError("slow down", status=429, retry_after=45)
    _past_the_delay(clock)
    store.flush()

    (op,) = [op for op in store.queue if op.kind == "notify"]
    assert op.attempts == 0
    clock.advance(44)
    store.flush()
    assert store.notifier.sent == []
    clock.advance(1)
    store.flush()
    assert len(store.notifier.sent) == 1


def test_a_refused_notify_gives_up_at_once_and_the_card_can_retry_it(told):
    # A 403 means this pod doesn't own the conversation.
    store, clock = told
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")
    store.flush()
    store.notifier.fail = ann.TransportError("forbidden", status=403)
    _past_the_delay(clock)
    store.flush()
    assert store.get(record.id).notify == "failed"
    assert not [op for op in store.queue if op.kind == "notify"]

    # Retry re-sends only the notify, never the push.
    store.retry(record.id)
    store.flush()
    assert len(store.transport.puts) == 1
    assert len(store.notifier.sent) == 1
    assert store.get(record.id).notify == "sent"


def test_a_remark_deleted_before_its_notify_is_not_announced(told):
    store, clock = told
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")
    store.transport.delete = lambda _id: None
    store.flush()
    store.delete(record.id)
    _past_the_delay(clock)
    store.flush()
    assert store.notifier.sent == []


def test_an_agent_reply_is_stored_but_never_announced(told):
    store, clock = told
    opener = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="why?")
    reply = store.add(
        content=DOC, path="doc.md", line=2, quote="bravo", text="because", thread=opener.id, by="agent"
    )
    store.flush()
    _past_the_delay(clock)
    store.flush()
    assert store.get(reply.id).state == "acked"
    assert [p["by"] for p in store.transport.puts] == ["reviewer", "agent"]
    (message,) = store.notifier.sent
    assert "why?" in message and "because" not in message


def test_an_unknown_author_is_refused(store):
    with pytest.raises(ann.AnnotationError):
        store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x", by="someone")


def test_a_pulled_agent_reply_keeps_its_author(store):
    store.transport.remote = [
        {"id": "r1", "path": "/workspace/doc.md", "anchor": {"line": 2}, "text": "hi",
         "author": {"conversation": "c", "by": "agent"}},
    ]
    store.pull()
    assert store.get("r1").by == "agent"


def test_an_owed_notify_survives_a_restart_and_a_pulled_thread_is_never_announced(
    tmp_path: Path,
):
    path = tmp_path / "annotations.json"
    clock = FakeClock()
    first = ann.Annotations(
        state_path=path, transport=FakeTransport(), notifier=FakeNotifier(), clock=clock
    )
    mine = first.add(content=DOC, path="doc.md", line=2, quote="bravo", text="mine")
    first.flush()  # acked, notify still owed

    transport = FakeTransport()
    transport.remote = [
        {"id": "old", "path": "/workspace/doc.md", "anchor": {"line": 4}, "text": "old news"}
    ]
    second = ann.Annotations(
        state_path=path, transport=transport, notifier=FakeNotifier(), clock=clock
    )
    second.pull()
    second.flush()
    (message,) = second.notifier.sent
    assert "mine" in message and "old news" not in message
    assert second.get(mine.id).notify == "sent"
    assert second.get("old").notify == ""


def test_with_no_self_access_remarks_are_stored_and_nothing_is_owed(tmp_path: Path):
    notifier = FakeNotifier()
    notifier.configured = False
    store = ann.Annotations(
        state_path=tmp_path / "annotations.json",
        transport=FakeTransport(),
        notifier=notifier,
        clock=FakeClock(),
    )
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")
    store.flush()
    assert store.get(record.id).state == "acked"
    assert record.notify == ""
    assert not store.queue


def test_the_self_transport_posts_to_its_own_conversation_with_its_token(tmp_path: Path):
    # The real client against a stand-in self-access listener.
    import http.server

    seen: list[tuple[str, str, dict]] = []
    status = {"code": 202}

    class Listener(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            seen.append((self.path, self.headers["authorization"], body))
            self.send_response(status["code"])
            if status["code"] == 429:
                self.send_header("Retry-After", "60")
            self.send_header("content-length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    httpd = http.server.HTTPServer(("127.0.0.1", 0), Listener)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        token = tmp_path / "token"
        token.write_text("pod-token\n")
        conv = "952b7375-aa3c-403b-b91f-81d1473e8b06"
        client = ann.SelfTransport(f"http://127.0.0.1:{httpd.server_address[1]}/", str(token), conv)
        assert client.configured
        client.send("hello")
        assert seen == [(f"/conversations/{conv}/messages", "Bearer pod-token", {"text": "hello", "source": "files"})]

        status["code"] = 429
        with pytest.raises(ann.TransportError) as caught:
            client.send("again")
        assert caught.value.status == 429 and caught.value.retry_after == 60.0
    finally:
        httpd.shutdown()
        httpd.server_close()

    assert not ann.SelfTransport("", str(token), conv).configured
    assert not ann.SelfTransport("http://x", str(token), "").configured


# --- never twice -----------------------------------------------------------------
#
# The router's POST /messages used to answer only once the agent had finished the
# turn it started, so the viewer timed out, retried, and woke the agent with the
# same remark up to five times.


def test_a_notify_that_got_no_answer_is_never_resent(told):
    store, clock = told
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")
    store.flush()
    store.notifier.fail = ann.TransportError("timed out", maybe_delivered=True)
    _past_the_delay(clock)
    store.flush()

    # It may well have landed, so it is never sent again.
    assert store.get(record.id).notify == "sent"
    assert not [op for op in store.queue if op.kind == "notify"]
    clock.advance(600)
    store.flush()
    assert store.notifier.sent == []


def test_a_restart_mid_send_does_not_send_again(tmp_path: Path):
    path = tmp_path / "annotations.json"
    clock = FakeClock()
    first = ann.Annotations(
        state_path=path, transport=FakeTransport(), notifier=FakeNotifier(), clock=clock
    )
    record = first.add(content=DOC, path="doc.md", line=2, quote="bravo", text="x")
    first.flush()
    _past_the_delay(clock)

    # The process dies inside send(): what is on disk then is what a restart sees.
    on_disk: list[dict] = []

    def die(_text: str) -> None:
        on_disk.extend(json.loads(path.read_text())["records"])
        raise SystemExit

    first.notifier.send = die
    with pytest.raises(SystemExit):
        first.flush()
    assert [r["notify"] for r in on_disk] == ["sending"]

    second = ann.Annotations(
        state_path=path, transport=FakeTransport(), notifier=FakeNotifier(), clock=clock
    )
    clock.advance(600)
    second.flush()
    assert second.notifier.sent == []
    assert second.get(record.id).notify == "sent"


def test_a_remark_queued_twice_is_named_once(told):
    store, clock = told
    record = store.add(content=DOC, path="doc.md", line=2, quote="bravo", text="only once")
    store.flush()
    # A second notify op for the same remark, however it got there.
    store.queue.append(ann._Op(kind="notify", key=record.id))
    _past_the_delay(clock)
    store.flush()
    (message,) = store.notifier.sent
    assert message.count("only once") == 1
    assert not [op for op in store.queue if op.kind == "notify"]


def test_the_self_transport_tells_a_lost_answer_from_a_refused_connection(tmp_path: Path):
    import http.server
    import socket

    class Slow(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            self.rfile.read(int(self.headers["content-length"]))
            time.sleep(1.5)  # past the client's timeout: it has the message, no answer
            self.send_response(202)
            self.send_header("content-length", "0")
            self.end_headers()

        def log_message(self, *args):
            pass

    token = tmp_path / "token"
    token.write_text("t")
    httpd = http.server.HTTPServer(("127.0.0.1", 0), Slow)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        client = ann.SelfTransport(
            f"http://127.0.0.1:{httpd.server_address[1]}", str(token), "c", timeout=0.5
        )
        with pytest.raises(ann.TransportError) as caught:
            client.send("hello")
        assert caught.value.maybe_delivered
    finally:
        httpd.shutdown()
        httpd.server_close()

    # Nothing listening: it never arrived, so a retry is safe.
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        free = s.getsockname()[1]
    client = ann.SelfTransport(f"http://127.0.0.1:{free}", str(token), "c", timeout=0.5)
    with pytest.raises(ann.TransportError) as caught:
        client.send("hello")
    assert not caught.value.maybe_delivered




# --- over HTTP ------------------------------------------------------------------
#
# The write routes are reached through the proxy prefix like every other route, so
# these drive a real socket rather than calling the handler.

import contextlib  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import urllib.error  # noqa: E402
import urllib.request  # noqa: E402

import server  # noqa: E402


@contextlib.contextmanager
def viewer(tmp_path: Path, *, with_store: bool = True, doc: str = DOC, name: str = "doc.md"):
    """A live viewer over a one-file workspace; yields (call, store)."""
    root = tmp_path / "ws"
    root.mkdir()
    (root / name).write_text(doc)
    cfg = server.Config(root=root, base="/c/conv-test/files", port=0, state=None)
    store = (
        ann.Annotations(
            state_path=tmp_path / "annotations.json",
            root=root,
            transport=FakeTransport(),
            clock=FakeClock(),
        )
        if with_store
        else None
    )
    httpd = server.make_server(cfg, store)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    port = httpd.server_address[1]

    def call(method: str, path: str, body: dict | None = None, *, base: bool = True):
        prefix = cfg.base if base else ""
        request = urllib.request.Request(
            f"http://127.0.0.1:{port}{prefix}{path}",
            method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"content-type": "application/json"} if body is not None else {},
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read() or b"{}")
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read() or b"{}")

    call.url = f"http://127.0.0.1:{port}{cfg.base}"
    call.root = root
    try:
        yield call, store
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_post_records_a_comment_and_get_lists_it(tmp_path: Path):
    with viewer(tmp_path) as (call, store):
        status, created = call(
            "POST",
            "/api/annotations",
            {"path": "doc.md", "line": 2, "quote": "bravo", "text": "why this?"},
        )
        # 202: recorded here, not yet committed anywhere durable.
        assert status == 202
        assert created["annotation"]["state"] == "pending"

        status, listed = call("GET", "/api/annotations?path=doc.md")
        assert status == 200
        assert [a["text"] for a in listed["annotations"]] == ["why this?"]
        assert listed["annotations"][0]["anchor_state"] == "ok"
        assert listed["counts"] == {"comments": 1, "pending": 1, "stale": 0}

        store.flush()
        _, listed = call("GET", "/api/annotations?path=doc.md")
        assert listed["annotations"][0]["state"] == "acked"


def test_post_refuses_an_anchor_the_file_no_longer_matches(tmp_path: Path):
    with viewer(tmp_path) as (call, _):
        status, body = call(
            "POST",
            "/api/annotations",
            {"path": "doc.md", "line": 2, "quote": "never written", "text": "x"},
        )
        assert status == 409
        assert "anchor" in body["error"]


def test_the_anchor_is_checked_against_disk_not_against_the_browser_copy(tmp_path: Path):
    with viewer(tmp_path) as (call, _):
        (tmp_path / "ws" / "doc.md").write_text("rewritten by the agent\n")
        status, _ = call(
            "POST",
            "/api/annotations",
            {"path": "doc.md", "line": 2, "quote": "bravo", "text": "x"},
        )
        assert status == 409


def test_resolve_and_retry_are_reachable_over_http(tmp_path: Path):
    with viewer(tmp_path) as (call, store):
        _, created = call(
            "POST", "/api/annotations", {"path": "doc.md", "line": 2, "quote": "bravo", "text": "x"}
        )
        record = created["annotation"]

        status, resolved = call(
            "POST", f"/api/annotations/threads/{record['thread']}/resolve", {"resolved": True}
        )
        assert (status, resolved["updated"]) == (200, 1)

        status, retried = call("POST", f"/api/annotations/{record['id']}/retry", {})
        assert (status, retried["annotation"]["state"]) == (200, "pending")


def test_the_cli_replies_and_resolves_through_the_viewer(tmp_path: Path):
    with viewer(tmp_path) as (call, store):
        _, created = call(
            "POST", "/api/annotations", {"path": "doc.md", "line": 2, "quote": "bravo", "text": "x"}
        )
        thread = created["annotation"]["thread"]
        port = call.url.split(":")[2].split("/")[0]
        env = {"CONVERSATION_ID": "conv-test", "SCOOTER_FILES_PORT": port}

        cli.main(["reply", thread, "done", "--resolve"], env=env)

        _, listed = call("GET", "/api/annotations?path=doc.md")
        texts = [(a["text"], a["by"], a["resolved"]) for a in listed["annotations"]]
        assert texts == [("x", "reviewer", True), ("done", "agent", True)]


@pytest.mark.parametrize(
    ("env", "base"),
    [
        ({"CONVERSATION_ID": "c1"}, "/c/c1/files"),
        ({"CONVERSATION_ID": "c1", "SCOOTER_SERVICES_ORIGIN": "https://x"}, "/files"),
        ({"CONVERSATION_ID": "c1", "SCOOTER_SERVICE_PREFIX": ""}, "/files"),
    ],
)
def test_the_cli_finds_the_viewer_under_the_proxys_prefix(env, base):
    assert cli.base_url(env) == f"http://127.0.0.1:7801{base}"


def test_a_viewer_with_no_store_says_so_rather_than_failing(tmp_path: Path):
    # The read-only deployment: `annotations.enable = false` ships the file browser
    # alone, and the page hides its comment affordances on this answer.
    with viewer(tmp_path, with_store=False) as (call, _):
        assert call("GET", "/api/annotations?path=doc.md")[0] == 501
        assert call("POST", "/api/annotations", {"path": "doc.md", "line": 1, "text": "x"})[0] == 501


def test_a_write_outside_the_proxy_prefix_is_not_this_service(tmp_path: Path):
    with viewer(tmp_path) as (call, _):
        status, _ = call(
            "POST",
            "/api/annotations",
            {"path": "doc.md", "line": 2, "quote": "bravo", "text": "x"},
            base=False,
        )
        assert status == 404


def test_a_hinted_line_that_moves_says_so_in_the_reply(tmp_path: Path):
    with viewer(tmp_path) as (call, _store):
        # The quote is the identity, so a wrong line hint still lands — and the reply
        # reports that it moved rather than silently re-pointing.
        status, body = call(
            "POST",
            "/api/annotations",
            {"path": "doc.md", "line": 1, "quote": "charlie", "text": "placed by quote"},
        )
        assert status == 202
        assert body["annotation"]["line"] == 3
        assert body["annotation"]["anchor_state"] == "moved"


def test_a_write_to_a_read_route_is_refused_as_read_only(tmp_path: Path):
    # 405, not 404: /api/file exists and answers a GET, so "no such route" would
    # misdescribe it. The VM test pins the same contract against the shipped unit.
    with viewer(tmp_path) as (call, _store):
        assert call("POST", "/api/file?path=doc.md", {})[0] == 405
        assert call("POST", "/api/list", {})[0] == 405
        # An unknown route is still a 404; only the read surface is "read-only".
        assert call("POST", "/api/nonsense", {})[0] == 404


def test_a_write_to_a_read_route_is_refused_as_read_only(tmp_path: Path):
    with viewer(tmp_path) as (call, _store):
        # 405, not 404, because the route exists and is readable: what the request got
        # wrong is that the tree is read-only.
        assert call("POST", "/api/file?path=doc.md", {})[0] == 405
        assert call("POST", "/api/list", {})[0] == 405
        assert call("POST", "/api/nope", {})[0] == 404


# --- the event stream ----------------------------------------------------------------


class _Events:
    """An open /api/events stream; next() is the next named event, or None on timeout."""

    def __init__(self, call, path: str = "doc.md") -> None:
        self.response = urllib.request.urlopen(f"{call.url}/api/events?path={path}", timeout=5)

    def next(self) -> str | None:
        try:
            while line := self.response.readline():
                if line.startswith(b"event: "):
                    return line[len(b"event: "):].strip().decode()
        except TimeoutError:
            return None
        return None

    def close(self) -> None:
        self.response.close()


def test_events_is_a_stream_and_a_write_to_the_store_is_a_notes_event(tmp_path: Path):
    with viewer(tmp_path) as (call, _store):
        events = _Events(call)
        try:
            assert events.response.headers["content-type"] == "text/event-stream"
            # The retry hint comes first, so the browser's reconnect delay is ours.
            assert events.response.readline() == b"retry: 2000\n"
            call("POST", "/api/annotations", {"path": "doc.md", "line": 2, "quote": "bravo", "text": "hm"})
            assert events.next() == "notes"
        finally:
            events.close()


def test_an_edit_on_disk_is_a_file_event(tmp_path: Path):
    with viewer(tmp_path) as (call, _store):
        events = _Events(call)
        try:
            (call.root / "doc.md").write_text(DOC + "echo\n")
            assert events.next() == "file"
        finally:
            events.close()


def test_a_viewer_without_a_store_still_streams_file_changes(tmp_path: Path):
    with viewer(tmp_path, with_store=False) as (call, _store):
        events = _Events(call)
        try:
            (call.root / "doc.md").unlink()
            assert events.next() == "file"
        finally:
            events.close()


@pytest.mark.parametrize("with_store", [True, False])
def test_a_change_right_after_the_stream_opens_is_still_a_file_event(tmp_path: Path, monkeypatch, with_store):
    # Regression: the baseline was taken after the headers, so a fast client's
    # change landed before it and was never reported (aarch64 publish, #883).
    real = server.Handler.end_headers

    def slow_end_headers(self):
        real(self)
        if "/api/events" in self.path:
            self.wfile.flush()
            time.sleep(0.3)  # the window a slower server leaves open

    monkeypatch.setattr(server.Handler, "end_headers", slow_end_headers)
    with viewer(tmp_path, with_store=with_store) as (call, _store):
        events = _Events(call)
        try:
            (call.root / "doc.md").unlink()
            assert events.next() == "file"
        finally:
            events.close()


def test_shutdown_ends_an_open_stream(tmp_path: Path):
    with viewer(tmp_path) as (call, _store):
        events = _Events(call)
    # The server closed the stream (EOF in about a second) rather than leaving its
    # thread waiting for the 5s read timeout.
    started = time.monotonic()
    assert events.next() is None
    assert time.monotonic() - started < 3
    events.close()


def test_events_refuses_a_path_outside_the_root(tmp_path: Path):
    with viewer(tmp_path) as (call, _store):
        assert call("GET", "/api/events?path=../outside")[0] in (400, 403, 404)
