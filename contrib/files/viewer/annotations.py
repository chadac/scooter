"""Viewer-side annotation state: anchors resolved against live content, and an
outbox that pushes to the broker.

The split with the broker half falls where it does because the broker cannot see the
file: it cannot validate an anchor or compute staleness, and this side can. So every
write passes through here, which resolves the anchor against the bytes on disk and
hands the broker something already known-good.

Broker-ack is the point an annotation becomes real — a local write that never reaches
the broker means the reader believes they commented and the agent never wakes. So the
sync state of every record is explicit and visible, and nothing is reported as
committed before the broker says so.

Acked remarks are then announced to the agent via the router's self-access listener.

Stdlib only: the viewer ships as a store path and runs on the sandbox's python with
no site-packages.
"""

from __future__ import annotations

import http.client
import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

# The same two kinds the broker stores: review discussion, and an answer to a
# `scooter:question` block.
KINDS = {"comment", "answer"}
# Who wrote a remark; the agent's own replies are never announced back to it.
AUTHORS = {"reviewer", "agent"}

# A quote is searched for this many lines either side of its recorded line before the
# whole file is scanned, so a moved anchor prefers a near occurrence to a far one.
NEAR_LINES = 50

# First retry delay; each further attempt doubles it.
BACKOFF_SECONDS = 2.0

# Wait before notifying, so a burst becomes one message.
NOTIFY_DELAY_SECONDS = 3.0

# Attempts before a push is abandoned and the card offers a manual retry, because a
# broker down for longer than this needs a human rather than more retries.
MAX_ATTEMPTS = 5

MAX_TEXT_BYTES = 16 * 1024
MAX_QUOTE_BYTES = 4 * 1024


class AnnotationError(ValueError):
    """A write this viewer refuses, reported to the browser as a 4xx."""


class AnchorError(AnnotationError):
    """The anchor does not match the file, so the annotation would be unplaceable."""


class TransportError(Exception):
    """A push failed; `status` carries the upstream's code when there was one."""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        retry_after: float | None = None,
        maybe_delivered: bool = False,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after
        # The request went out but no answer came back, so it may have landed. A
        # retry could then deliver it twice.
        self.maybe_delivered = maybe_delivered


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class Anchor:
    """Where an annotation attaches: the line is a hint, the quote is the identity."""

    line: int
    quote: str = ""


def resolve_anchor(content: str, anchor: Anchor) -> tuple[int, str]:
    """Return the anchor's line in `content` and one of ok / moved / stale.

    The line is trusted only while the quote still matches there; otherwise the quote
    is searched for, nearest the recorded line first. A quote that is gone is reported
    stale rather than moved to whatever is closest, because a thread pointing at text
    that no longer says what it quoted is worse than one admitting it lost its place.
    """
    lines = content.splitlines()
    if not anchor.quote:
        # Nothing to match, so the line is all there is to trust.
        return anchor.line, "ok" if 1 <= anchor.line <= len(lines) else "stale"

    if 1 <= anchor.line <= len(lines) and anchor.quote in lines[anchor.line - 1]:
        return anchor.line, "ok"

    hits = _quote_lines(content, lines, anchor.quote)
    if hits:
        nearest = min(hits, key=lambda line: (abs(line - anchor.line), line))
        return nearest, "moved"
    return anchor.line, "stale"


def _quote_lines(content: str, lines: list[str], quote: str) -> list[int]:
    """Every line a quote starts on, by substring match."""
    if "\n" in quote:
        # A selection spanning lines matches the joined text; its first line is the anchor.
        found, start = [], 0
        while (at := content.find(quote, start)) != -1:
            found.append(content.count("\n", 0, at) + 1)
            start = at + 1
        return found
    near = [i + 1 for i, line in enumerate(lines) if quote in line]
    return near


@dataclass
class Record:
    """One annotation as this viewer holds it, with its sync state."""

    id: str
    path: str
    line: int
    quote: str
    kind: str
    text: str
    thread: str
    question_id: str = ""
    by: str = "reviewer"
    resolved: bool = False
    created_at: str = ""
    updated_at: str = ""
    # pending while the broker has not acked, then acked; failed once the retries are
    # spent, and disabled when the deployment stores no annotations at all.
    state: str = "pending"
    attempts: int = 0
    error: str = ""
    next_attempt: float = 0.0
    # "", pending, sending, sent or failed; pulled records stay "". "sending" is saved
    # before the request goes out, so a restart mid-send never sends it again.
    notify: str = ""

    @property
    def anchor(self) -> Anchor:
        return Anchor(line=self.line, quote=self.quote)

    def payload(self) -> dict:
        """The body the broker's PUT takes."""
        return {
            "id": self.id,
            "path": self.path,
            "anchor": {"line": self.line, "quote": self.quote},
            "kind": self.kind,
            "text": self.text,
            "thread": self.thread,
            "question_id": self.question_id,
            "by": self.by,
            "resolved": self.resolved,
            "created_at": self.created_at,
        }

    def view(self, *, line: int | None = None, anchor_state: str = "unknown") -> dict:
        """What the browser renders: the record plus where its anchor landed."""
        return asdict(self) | {
            "line": self.line if line is None else line,
            "recorded_line": self.line,
            "anchor_state": anchor_state,
        }


class BrokerTransport:
    """The broker's `files` provider over the pod's projected ServiceAccount token.

    The token is re-read per attempt because a projected token is rotated in place,
    and the outbox may be retrying across a rotation.
    """

    def __init__(self, base_url: str, token_path: str, *, timeout: float = 10.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token_path = token_path
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.base_url)

    def _token(self) -> str:
        try:
            return Path(self.token_path).read_text().strip()
        except OSError as exc:
            raise TransportError(f"no broker token: {exc}") from exc

    def _call(self, method: str, path: str, body: dict | None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            f"{self.base_url}/files/annotations{path}",
            data=data,
            method=method,
            headers={
                "authorization": f"Bearer {self._token()}",
                "content-type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:400].decode(errors="replace")
            raise TransportError(f"broker {exc.code}: {detail}", status=exc.code) from exc
        except (urllib.error.URLError, OSError) as exc:
            raise TransportError(str(exc)) from exc
        return json.loads(raw or b"{}")

    def put(self, payload: dict) -> dict:
        return self._call("PUT", f"/{payload['id']}", payload)

    def resolve(self, thread: str, resolved: bool) -> None:
        self._call("POST", f"/threads/{thread}/resolve", {"resolved": resolved})

    def delete(self, annotation_id: str) -> None:
        self._call("DELETE", f"/{annotation_id}", None)

    def pull(self) -> list[dict]:
        return self._call("GET", "", None).get("annotations", [])


class SelfTransport:
    """Posts to this conversation through the router's self-access listener."""

    def __init__(
        self, base_url: str, token_path: str, conversation_id: str, *, timeout: float = 10.0
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.token_path = token_path
        self.conversation_id = conversation_id
        self.timeout = timeout

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.token_path and self.conversation_id)

    def send(self, text: str) -> None:
        """Deliver once. A failure with maybe_delivered set must not be retried."""
        try:
            token = Path(self.token_path).read_text().strip()
        except OSError as exc:
            raise TransportError(f"no self-access token: {exc}") from exc
        request = urllib.request.Request(
            f"{self.base_url}/conversations/{self.conversation_id}/messages",
            # Tagged with this contrib's name so the UI shows a review remark as a Files event, not a user turn.
            data=json.dumps({"text": text, "source": "files"}).encode(),
            method="POST",
            headers={"authorization": f"Bearer {token}", "content-type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read()[:400].decode(errors="replace")
            try:
                retry_after = float(exc.headers.get("retry-after") or "")
            except ValueError:
                retry_after = None
            raise TransportError(
                f"self-access {exc.code}: {detail}",
                status=exc.code,
                retry_after=retry_after,
                # A gateway timeout: the upstream may have taken it before giving up.
                maybe_delivered=exc.code == 504,
            ) from exc
        except urllib.error.URLError as exc:
            # urllib wraps only failures to connect or send, so it never arrived.
            raise TransportError(str(exc)) from exc
        except (OSError, http.client.HTTPException) as exc:
            # Sent, but the answer never came (a read timeout, a dropped connection).
            raise TransportError(f"no answer: {exc}", maybe_delivered=True) from exc


def reply_hint(thread: str) -> str:
    """How to answer a thread, so the reply lands beside the line."""
    return (
        f'Answer with `scooter-files reply {thread} "…"` (add `--resolve` if that settles it)'
        f" or `scooter-files resolve {thread}`."
    )


def notify_message(records: list[Record], root: Path) -> str:
    """One message naming each remark's file, line, quote and text."""
    blocks = []
    for record in records:
        what = "answered a question in" if record.kind == "answer" else "commented on"
        where = f"{root / record.path}:{record.line}"
        lines = [f"A reviewer {what} {where}."]
        if record.quote:
            lines.append(f"Anchored to: {record.quote!r}")
        if record.question_id:
            lines.append(f"Question: {record.question_id}")
        if record.thread != record.id:
            lines.append(f"In reply to thread {record.thread}.")
        lines.append(f"\n{record.text}")
        if record.kind == "comment":
            lines.append(f"\n{reply_hint(record.thread)}")
        blocks.append("\n".join(lines))
    paths = sorted({r.path for r in records})
    tail = "Open the files viewer to see the thread in context (" + ", ".join(
        f"?path={p}" for p in paths
    ) + ")."
    head = f"{len(records)} new review remarks:\n\n" if len(records) > 1 else ""
    return head + "\n\n---\n\n".join(blocks) + "\n\n" + tail


@dataclass
class _Op:
    """Queued work: a record to push, a thread to resolve, or a record to forget."""

    kind: str
    key: str
    resolved: bool = False
    attempts: int = 0
    next_attempt: float = 0.0


@dataclass
class Annotations:
    """The viewer's annotation store: durable on the PVC, synced through an outbox."""

    state_path: Path
    transport: object
    # Held workspace-relative as the browser asks for them, pushed absolute as a
    # waking agent can act on them; the root converts between the two.
    root: Path = Path("/workspace")
    # SelfTransport; None or unconfigured means remarks go unannounced.
    notifier: object | None = None
    clock: object = time.monotonic
    records: dict[str, Record] = field(default_factory=dict)
    queue: list[_Op] = field(default_factory=list)
    _lock: threading.RLock = field(default_factory=threading.RLock)
    _worker: threading.Thread | None = None
    _stop: threading.Event = field(default_factory=threading.Event)
    # Bumped on every write, so an open page's event stream knows to refetch.
    generation: int = 0
    _changed: threading.Condition = field(default_factory=threading.Condition)

    def __post_init__(self) -> None:
        self.state_path = Path(self.state_path)
        self._load()

    # --- durability -------------------------------------------------------------

    def _load(self) -> None:
        try:
            raw = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            return
        for row in raw.get("records", []):
            known = {f for f in Record.__dataclass_fields__}
            record = Record(**{k: v for k, v in row.items() if k in known})
            self.records[record.id] = record
            # A record the broker never acked is still owed, so a restart re-queues it.
            if record.state in ("pending", "failed"):
                self.queue.append(_Op(kind="put", key=record.id))
            # Stored but not yet announced.
            elif record.state == "acked" and record.notify == "pending":
                self.queue.append(_Op(kind="notify", key=record.id))
            # Caught mid-send. It may have arrived, and a duplicate wakes the agent
            # again, so it counts as sent.
            if record.notify == "sending":
                record.notify = "sent"

    def _save(self) -> None:
        # Atomic replace: a half-written state file would lose every thread, and this
        # is the only copy until the broker acks.
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_path.with_suffix(".tmp")
        payload = {"version": 1, "records": [asdict(r) for r in self.records.values()]}
        tmp.write_text(json.dumps(payload, indent=1))
        os.replace(tmp, self.state_path)
        with self._changed:
            self.generation += 1
            self._changed.notify_all()

    def wait_change(self, since: int, timeout: float) -> int:
        """The generation once it passes `since`, or the current one after `timeout`."""
        with self._changed:
            self._changed.wait_for(lambda: self.generation != since, timeout)
            return self.generation

    # --- writes -----------------------------------------------------------------

    def add(
        self,
        *,
        content: str,
        path: str,
        line: int,
        quote: str = "",
        text: str,
        kind: str = "comment",
        thread: str = "",
        question_id: str = "",
        by: str = "reviewer",
    ) -> Record:
        """Record an annotation against live content, and queue it for the broker."""
        if kind not in KINDS:
            raise AnnotationError(f"kind must be one of {sorted(KINDS)}")
        if by not in AUTHORS:
            raise AnnotationError(f"by must be one of {sorted(AUTHORS)}")
        if not text.strip():
            raise AnnotationError("text is required")
        if len(text.encode()) > MAX_TEXT_BYTES:
            raise AnnotationError("text is too long")
        if len(quote.encode()) > MAX_QUOTE_BYTES:
            raise AnnotationError("quote is too long")
        if kind == "answer" and not question_id:
            raise AnnotationError("an answer needs a question_id")
        if not isinstance(line, int) or line < 1:
            raise AnnotationError("line must be a positive integer")

        at, state = resolve_anchor(content, Anchor(line=line, quote=quote))
        if state == "stale":
            raise AnchorError("the anchor no longer matches the file")

        now = _now_iso()
        record = Record(
            id=str(uuid.uuid4()),
            path=path,
            line=at,
            quote=quote,
            kind=kind,
            text=text,
            thread="",
            question_id=question_id,
            by=by,
            created_at=now,
            updated_at=now,
        )
        # A remark with no thread of its own starts one, which is the first comment
        # on a line; the broker applies the same rule to its own default.
        record.thread = thread or record.id
        if self._can_notify and by != "agent":
            record.notify = "pending"
        with self._lock:
            self.records[record.id] = record
            self.queue.append(_Op(kind="put", key=record.id))
            self._save()
        return record

    def reply(self, *, thread: str, text: str, content_of, by: str = "agent") -> Record:
        """Reply in a thread at its opener's anchor; `content_of` reads a path."""
        with self._lock:
            members = sorted(
                (r for r in self.records.values() if r.thread == thread),
                key=lambda r: (r.id != thread, r.created_at),
            )
        if not members:
            raise AnnotationError("no such thread")
        head = members[0]
        content = content_of(head.path)
        if content is None:
            raise AnchorError("the annotated file is not readable")
        line, state = resolve_anchor(content, head.anchor)
        quote = head.quote
        if state == "stale":
            # Threads sit at their opener, so keep only the line.
            line, quote = min(line, max(1, len(content.splitlines()))), ""
        return self.add(
            content=content, path=head.path, line=line, quote=quote,
            text=text, thread=thread, by=by,
        )

    def resolve(self, thread: str, resolved: bool) -> int:
        """Resolve or reopen a thread locally, and queue the same for the broker."""
        with self._lock:
            touched = [r for r in self.records.values() if r.thread == thread]
            if not touched:
                raise AnnotationError("no such thread")
            for record in touched:
                record.resolved = resolved
                record.updated_at = _now_iso()
            self.queue.append(_Op(kind="resolve", key=thread, resolved=resolved))
            self._save()
        return len(touched)

    def delete(self, annotation_id: str) -> list[str]:
        """Forget an annotation here, and queue the same for the broker.

        Deleting the comment that opened a thread takes its replies with it: a reply
        whose parent is gone reads as a remark about nothing. The delete is queued
        even for a record the broker never acked, because a push may be in flight;
        the broker treats forgetting what it does not have as already done.
        """
        with self._lock:
            record = self.records.get(annotation_id)
            if record is None:
                raise AnnotationError("no such annotation")
            doomed = (
                [r for r in self.records.values() if r.thread == record.thread]
                if record.id == record.thread
                else [record]
            )
            removed = []
            for victim in doomed:
                self.records.pop(victim.id, None)
                # A queued push for a record that no longer exists must not be
                # retried into existence after the delete.
                self.queue = [
                    op for op in self.queue if not (op.kind == "put" and op.key == victim.id)
                ]
                self.queue.append(_Op(kind="delete", key=victim.id))
                removed.append(victim.id)
            self._save()
        return removed

    def retry(self, annotation_id: str) -> Record:
        """Re-queue an abandoned or refused push, at the reader's request."""
        with self._lock:
            record = self.records.get(annotation_id)
            if record is None:
                raise AnnotationError("no such annotation")
            if record.state == "acked":
                # Already stored, so only the notify can be retried.
                if record.notify == "failed":
                    record.notify = "pending"
                    self.queue.append(_Op(kind="notify", key=record.id))
            else:
                record.state = "pending"
                record.attempts = 0
                record.next_attempt = 0.0
                self.queue.append(_Op(kind="put", key=record.id))
            self._save()
        return record

    # --- reads ------------------------------------------------------------------

    def get(self, annotation_id: str) -> Record:
        with self._lock:
            record = self.records.get(annotation_id)
        if record is None:
            raise AnnotationError("no such annotation")
        return record

    def list(self, *, path: str = "", content: str | None = None) -> list[dict]:
        """Annotations for a path, each anchored against `content` when it is open."""
        with self._lock:
            records = [r for r in self.records.values() if not path or r.path == path]
        out = []
        for record in records:
            if content is None:
                out.append(record.view())
                continue
            at, state = resolve_anchor(content, record.anchor)
            out.append(record.view(line=at, anchor_state=state))
        out.sort(key=lambda r: (r["line"], r["created_at"]))
        return out

    def counts(self, *, path: str = "", contents: dict[str, str] | None = None) -> dict[str, int]:
        """What the rail badges: open discussion, un-acked syncs, lost anchors.

        Scoped to a path when one is given, because the rail's number and the list
        under it have to be the same set — a tab reading 3 over a list of 1 is worse
        than no number at all.
        """
        with self._lock:
            records = [r for r in self.records.values() if not path or r.path == path]
        threads = {r.thread for r in records if r.kind == "comment" and not r.resolved}
        stale = 0
        for record in records:
            body = (contents or {}).get(record.path)
            if body is not None and resolve_anchor(body, record.anchor)[1] == "stale":
                stale += 1
        return {
            "comments": len(threads),
            "pending": sum(1 for r in records if r.state != "acked"),
            "stale": stale,
        }

    # --- sync -------------------------------------------------------------------

    def _absolute(self, rel: str) -> str:
        return str(self.root / rel)

    def _relative(self, remote: str) -> str:
        """A broker path back to this viewer's key, left alone if it is not ours.

        A path from another root is kept verbatim rather than mangled: it will simply
        match no open file, which is the honest outcome for a thread about a file this
        workspace does not have. An already-relative path lands here too, and is
        likewise left as it is.
        """
        try:
            return str(Path(remote).relative_to(self.root))
        except ValueError:
            return remote

    def pull(self) -> int:
        """Rehydrate threads from the broker, which a restarted viewer has never seen.

        The broker is authoritative only for records this viewer does not hold: a
        local record may be mid-flight with edits the broker has not taken yet, and
        overwriting it with the stored copy would lose them.
        """
        try:
            remote = self.transport.pull()
        except TransportError as exc:
            logger.warning("annotation pull failed: %s", exc)
            return 0
        added = 0
        with self._lock:
            for row in remote:
                if row.get("id") in self.records:
                    continue
                anchor = row.get("anchor") or {}
                record = Record(
                    id=row["id"],
                    path=self._relative(row.get("path", "")),
                    line=int(anchor.get("line") or 1),
                    quote=anchor.get("quote") or "",
                    kind=row.get("kind") or "comment",
                    text=row.get("text") or "",
                    thread=row.get("thread") or row["id"],
                    question_id=row.get("question_id") or "",
                    by=_by(row),
                    resolved=bool(row.get("resolved")),
                    created_at=row.get("created_at") or "",
                    updated_at=row.get("updated_at") or "",
                    state="acked",
                )
                self.records[record.id] = record
                added += 1
            if added:
                self._save()
        return added

    def flush(self) -> int:
        """Attempt every queued op whose backoff has elapsed; returns ops completed."""
        now = self.clock()
        with self._lock:
            due = [op for op in self.queue if op.next_attempt <= now]
        done = 0
        for op in due:
            if op.kind != "notify" and self._attempt(op, now):
                done += 1
        done += self._notify([op for op in due if op.kind == "notify"], now)
        if done:
            with self._lock:
                self._save()
        return done

    @property
    def _can_notify(self) -> bool:
        return self.notifier is not None and getattr(self.notifier, "configured", True)

    def _notify(self, ops: list[_Op], now: float) -> int:
        """Announce all due remarks in one message."""
        with self._lock:
            live = []
            for op in ops:
                record = self.records.get(op.key)
                # Deleted, already announced, or queued twice in this batch.
                if (
                    record is None
                    or record.notify != "pending"
                    or not self._can_notify
                    or any(r is record for _, r in live)
                ):
                    self._drop(op)
                else:
                    live.append((op, record))
            if not live:
                return 0
            # On disk before the request goes out: see _load.
            for _, record in live:
                record.notify = "sending"
            self._save()
        records = sorted((r for _, r in live), key=lambda r: (r.path, r.line, r.created_at))
        try:
            self.notifier.send(notify_message(records, self.root))
        except TransportError as exc:
            if exc.maybe_delivered:
                # Possibly delivered: once is better than twice.
                logger.warning("annotation notify got no answer; not resending: %s", exc)
            else:
                with self._lock:
                    for op, record in live:
                        record.notify = "pending"
                for op, _ in live:
                    self._failed(op, exc, now)
                return 0
        with self._lock:
            for op, record in live:
                record.notify = "sent"
                self._drop(op)
        return len(live)

    def _attempt(self, op: _Op, now: float) -> bool:
        """One push; on failure the op stays queued with its backoff extended."""
        try:
            if op.kind == "resolve":
                self.transport.resolve(op.key, op.resolved)
            elif op.kind == "delete":
                self.transport.delete(op.key)
            else:
                record = self.records.get(op.key)
                if record is None or record.state == "acked":
                    self._drop(op)
                    return False
                self.transport.put(record.payload() | {"path": self._absolute(record.path)})
        except TransportError as exc:
            self._failed(op, exc, now)
            return False

        with self._lock:
            record = self.records.get(op.key)
            if op.kind == "put" and record is not None:
                record.state = "acked"
                record.error = ""
                # Delayed so the next few remarks share the message.
                if record.notify == "pending":
                    self.queue.append(
                        _Op(kind="notify", key=record.id, next_attempt=now + NOTIFY_DELAY_SECONDS)
                    )
            self._drop(op)
        return True

    def _failed(self, op: _Op, exc: TransportError, now: float) -> None:
        if op.kind == "notify":
            self._notify_failed(op, exc, now)
            return
        with self._lock:
            op.attempts += 1
            op.next_attempt = now + BACKOFF_SECONDS * (2 ** (op.attempts - 1))
            record = self.records.get(op.key) if op.kind == "put" else None
            # A 404 is the broker saying it stores no annotations here, which retrying
            # cannot fix; anything else is worth the backoff.
            disabled = exc.status == 404
            if disabled or op.attempts >= MAX_ATTEMPTS:
                self._drop(op)
            if record is not None:
                record.attempts = op.attempts
                record.error = str(exc)
                if disabled:
                    record.state = "disabled"
                elif op.attempts >= MAX_ATTEMPTS:
                    record.state = "failed"
            self._save()
        logger.warning("annotation push failed (attempt %d): %s", op.attempts, exc)

    def _notify_failed(self, op: _Op, exc: TransportError, now: float) -> None:
        """Back off a failed notify."""
        with self._lock:
            record = self.records.get(op.key)
            if exc.status == 429:
                # Rate-limited: wait as told, without spending an attempt.
                op.next_attempt = now + (exc.retry_after or 60.0)
                self._save()
                logger.info("annotation notify rate-limited; retrying in %.0fs", op.next_attempt - now)
                return
            op.attempts += 1
            op.next_attempt = now + BACKOFF_SECONDS * (2 ** (op.attempts - 1))
            # Retrying cannot fix a 403 or 404.
            if exc.status in (403, 404) or op.attempts >= MAX_ATTEMPTS:
                self._drop(op)
                if record is not None:
                    record.notify = "failed"
            self._save()
        logger.warning(
            "annotation notify failed (attempt %d; the remark is stored): %s", op.attempts, exc
        )

    def _drop(self, op: _Op) -> None:
        with self._lock:
            if op in self.queue:
                self.queue.remove(op)

    # --- the worker -------------------------------------------------------------

    def start(self, *, interval: float = 1.0) -> None:
        """Pull once, then drain the outbox on a daemon thread."""
        if not getattr(self.transport, "configured", True):
            logger.warning("no broker URL: annotations stay local and the agent will not wake")
            return
        if not self._can_notify:
            logger.warning(
                "no SCOOTER_SELF_URL, scooter-self token or CONVERSATION_ID: annotations are "
                "stored but the agent will not be notified of them"
            )
        self.pull()

        def loop() -> None:
            while not self._stop.wait(interval):
                try:
                    self.flush()
                except Exception:  # a dead outbox thread would lose every later push
                    logger.exception("annotation outbox pass failed")

        self._worker = threading.Thread(target=loop, name="annotation-outbox", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._stop.set()
        if self._worker is not None:
            self._worker.join(timeout=2)


def _by(row: dict) -> str:
    """Who wrote a pulled row; anything unrecognised reads as a reviewer."""
    by = row.get("by") or (row.get("author") or {}).get("by") or "reviewer"
    return by if by in AUTHORS else "reviewer"
