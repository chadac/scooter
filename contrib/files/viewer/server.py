"""The files viewer: a read-only HTTP view of the sandbox workspace.

Runs INSIDE the sandbox, so listing and reading are ordinary local filesystem calls
and there is no file-read endpoint on the control plane to secure. The agent-host
reverse-proxies it at /c/<conversation>/files/ and does NOT strip that prefix, so
every route is resolved after `base` is removed and every link the page emits is
rooted at `base`.

Stdlib only, deliberately: this ships in the sandbox image, where a FastAPI/uvicorn
closure would be paid for by every conversation whether or not anyone opens the
viewer.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import posixpath
import re
import threading
import urllib.parse
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# A sibling module, imported under a short name because `from __future__ import
# annotations` already binds the bare one.
import annotations as ann
import questions as q

# The built frontend (../viewer-ui, `npm run build`), which Nix bakes into its own
# store path and hands over as SCOOTER_FILES_STATIC; a checkout reads its dist/.
DEFAULT_STATIC = Path(__file__).resolve().parent.parent / "viewer-ui" / "dist"

# Served in place of the app when its build is missing, so a checkout that never
# ran `npm run build` says so instead of 404ing at its own root.
UNBUILT_PAGE = """<!doctype html><meta charset="utf-8"><title>Files</title>
<script>window.__BASE__ = "{{BASE}}";</script>
<p>The viewer's frontend is not built. Run <code>npm ci &amp;&amp; npm run build</code>
in <code>contrib/files/viewer-ui</code>, or set SCOOTER_FILES_STATIC.</p>
"""

# A file past this is served as metadata only: the viewer renders text, and a
# multi-megabyte blob is a download, not something to read in a browser.
MAX_READ_BYTES = 2 * 1024 * 1024

# /api/raw backs <img>: the limit is what a page can inline, not what reads as text.
MAX_RAW_BYTES = 16 * 1024 * 1024

# Only these are served as bytes; widening it makes /api/raw a download endpoint
# for the whole workspace. Why that is not wanted: PR #772.
RAW_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico", ".bmp"}

# Text files the page renders rather than shows as source.
RENDERERS = {".md": "markdown", ".markdown": "markdown", ".html": "html", ".htm": "html"}

# A write body is a comment and its quote, never a file, so anything larger is a bug
# or an attack whose read would cost the pod's memory.
MAX_BODY_BYTES = 128 * 1024

# Readable and never writable; a POST to one of these is refused as 405.
READ_ONLY_ROUTES = ("/api/list", "/api/file", "/api/raw", "/api/health", "/api/questions", "/api/events")

# The event stream checks the open file this often (stdlib has no inotify; a stat is
# cheap and local), and sends a comment line this often so a proxy never idles it out.
EVENTS_STAT_S = 1.0
EVENTS_HEARTBEAT_S = 15.0

# Directories that are never interesting to review and enormous to walk.
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".mypy_cache", ".pytest_cache", "result"}

# Dotfiles are noise in a review view, with two exceptions worth reading.
SHOW_DOTS = {".github", ".scooter"}


class _Unavailable(Exception):
    """This viewer was configured without the feature the request needs."""


@dataclass(frozen=True)
class Config:
    """Everything the unit passes in, resolved once at startup rather than per
    request — and a seam, so a test configures a viewer instead of re-importing
    this module with a different environment."""

    root: Path
    base: str
    port: int
    # The built frontend: index.html plus its hashed assets.
    static: Path = DEFAULT_STATIC
    # Annotation state, on the workspace PVC so threads survive a hibernate; None
    # keeps the viewer a read-only file browser.
    state: Path | None = None
    # The broker's `files` provider and the pod's projected token for it, where an
    # empty URL leaves annotations local and reported as never committed.
    broker_url: str = ""
    token_path: str = "/var/run/secrets/broker/token"
    # Self-access listener; any missing leaves remarks unannounced.
    self_url: str = ""
    self_token_path: str = ""
    conversation_id: str = ""
    # This conversation's chat page, linked from the header.
    conversation_url: str = ""

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Config:
        env = os.environ if env is None else env
        static = env.get("SCOOTER_FILES_STATIC", "")
        root = Path(env.get("SCOOTER_FILES_ROOT", "/workspace")).resolve()
        state = env.get("SCOOTER_FILES_STATE", "")
        return cls(
            root=root,
            # Trailing slash stripped: every route is formed as base + "/…", so a
            # slash here would double up in all of them.
            base=env.get("SCOOTER_FILES_BASE", "").rstrip("/"),
            port=int(env.get("SCOOTER_FILES_PORT", "7801")),
            static=Path(static).resolve() if static else DEFAULT_STATIC,
            state=Path(state) if state else root / ".scooter/files/annotations.json",
            broker_url=env.get("BROKER_URL", ""),
            token_path=env.get("BROKER_TOKEN_PATH", "/var/run/secrets/broker/token"),
            self_url=env.get("SCOOTER_SELF_URL", ""),
            self_token_path=env.get("SCOOTER_SELF_TOKEN_PATH", ""),
            conversation_id=env.get("CONVERSATION_ID", ""),
            conversation_url=env.get("CONVERSATION_URL", ""),
        )


def resolve(root: Path, rel: str) -> Path:
    """Resolve a request path under `root`, raising ValueError if it escapes.

    Escapes are refused even though this is not a trust boundary — whoever reaches
    this service has the terminal on the same pod — because a viewer that can be
    walked up to `/` turns every stray `../` in a link into a confusing 200.
    """
    candidate = (root / rel.lstrip("/")).resolve()
    # Agents write host paths like /workspace/a.png; read them as meant.
    if rel.startswith(f"{root}/") and not candidate.exists():
        candidate = (root / rel[len(str(root)) :].lstrip("/")).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("path escapes the workspace root")
    return candidate


def rel_of(root: Path, path: Path) -> str:
    return "" if path == root else str(path.relative_to(root))


def listing(root: Path, path: Path) -> dict:
    """One directory, directories first, with a flag for git repos."""
    entries = []
    with os.scandir(path) as it:
        for entry in it:
            if entry.name.startswith(".") and entry.name not in SHOW_DOTS:
                continue
            try:
                is_dir = entry.is_dir()
            except OSError:
                is_dir = False
            try:
                size = None if is_dir else entry.stat(follow_symlinks=False).st_size
            except OSError:
                size = None
            entries.append(
                {
                    "name": entry.name,
                    "kind": "dir" if is_dir else "file",
                    "size": size,
                    "skip": entry.name in SKIP_DIRS,
                    # The diff renderer is not built yet; this is the flag it keys on.
                    "repo": is_dir and (Path(entry.path) / ".git").exists(),
                }
            )
    entries.sort(key=lambda e: (e["kind"] != "dir", e["name"].lower()))
    return {"path": rel_of(root, path), "entries": entries}


def etag_of(body: str) -> str:
    return hashlib.sha256(body.encode("utf-8", errors="replace")).hexdigest()[:16]


def read_file(root: Path, path: Path) -> dict:
    """One file as text, or metadata explaining why it is not being rendered."""
    st = path.stat()
    size = st.st_size
    out = {"path": rel_of(root, path), "size": size, "body": "", "renderer": "code"}

    suffix = path.suffix.lower()
    if suffix in RAW_SUFFIXES and size <= MAX_RAW_BYTES:
        # The page shows it via /api/raw; the stamp lets a poll see changes.
        image = out | {"renderer": "image", "etag": etag_of(f"{size}:{st.st_mtime_ns}")}
        if suffix != ".svg" or size > MAX_READ_BYTES:
            return image
        # An SVG is also text, so its Source view needs a body.
        body = path.read_bytes().decode("utf-8", errors="replace")
        return image | {"body": body, "lines": body.count("\n") + 1, "etag": etag_of(body)}

    if size > MAX_READ_BYTES:
        return out | {"renderer": "too-large"}

    raw = path.read_bytes()
    # A NUL in the first block is the cheap binary test every pager uses.
    if b"\0" in raw[:8192]:
        return out | {"renderer": "binary"}

    body = raw.decode("utf-8", errors="replace")
    return out | {
        "body": body,
        "lines": body.count("\n") + 1,
        "etag": etag_of(body),
        # Which of the page's renderers gets the body; markdown is parsed in the
        # browser, where the sanitizer that must see the result lives.
        "renderer": RENDERERS.get(suffix, "code"),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "scooter-files/0.1"
    protocol_version = "HTTP/1.1"

    @property
    def cfg(self) -> Config:
        return self.server.cfg  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:
        # Journald already timestamps; the default handler's stderr format double-stamps.
        print(f"files-viewer {fmt % args}", flush=True)

    # --- replies ----------------------------------------------------------------

    def send_body(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("content-type", content_type)
        self.send_header("content-length", str(len(body)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_body(status, json.dumps(payload).encode(), "application/json")

    def fail(self, status: HTTPStatus, message: str) -> None:
        self.send_json({"error": message}, status)

    # --- routing ----------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's casing
        # Traffic that skips the prefix is not this service's: the proxy always sends
        # the whole path, so a bare /api/list is someone else's request.
        route, want = self.route_of(self.path)
        if route is None:
            return self.fail(HTTPStatus.NOT_FOUND, "not under this service's base path")

        try:
            if route in ("/", "."):
                return self.serve_index()
            if route.startswith("/static/"):
                return self.serve_static(route[len("/static/"):])
            if route == "/api/list":
                return self.serve_list(want)
            if route == "/api/file":
                return self.serve_file(want)
            if route == "/api/raw":
                return self.serve_raw(want)
            if route == "/api/annotations":
                return self.serve_annotations(want)
            if route == "/api/questions":
                return self.serve_questions(want)
            if route == "/api/events":
                return self.serve_events(want)
            if route == "/api/health":
                return self.send_json(
                    {
                        "ok": True,
                        "root": str(self.cfg.root),
                        "base": self.cfg.base,
                        # First thing to check when the page is a "not built" note.
                        "frontend": self.built,
                    }
                )
        except _Unavailable as exc:
            return self.fail(HTTPStatus.NOT_IMPLEMENTED, str(exc))
        except ValueError as exc:
            return self.fail(HTTPStatus.BAD_REQUEST, str(exc))
        except FileNotFoundError:
            return self.fail(HTTPStatus.NOT_FOUND, "no such path")
        except PermissionError:
            return self.fail(HTTPStatus.FORBIDDEN, "permission denied")

        self.fail(HTTPStatus.NOT_FOUND, f"no route {route}")

    # --- annotations ------------------------------------------------------------

    @property
    def store(self) -> ann.Annotations:
        """The annotation store, or a 501 for a viewer configured without one."""
        store = getattr(self.server, "store", None)
        if store is None:
            raise _Unavailable("this viewer stores no annotations")
        return store

    def live_content(self, want: str) -> str | None:
        """The file's current text, which anchors are resolved against.

        Read here rather than taken from the request: the browser's copy may be a
        scroll behind an agent's edit, and an anchor validated against stale text is
        exactly the unplaceable comment this check exists to refuse.
        """
        if not want:
            return None
        try:
            target = resolve(self.cfg.root, want)
            if not target.is_file() or target.stat().st_size > MAX_READ_BYTES:
                return None
            return target.read_bytes().decode("utf-8", errors="replace")
        except (ValueError, OSError):
            return None

    def annotations(self, want: str, content: str | None) -> list[dict]:
        return self.store.list(path=want, content=content)

    def counts(self, want: str, content: str | None) -> dict:
        return self.store.counts(
            path=want, contents={want: content} if content is not None else None
        )

    def serve_annotations(self, want: str) -> None:
        content = self.live_content(want)
        self.send_json(
            {
                "annotations": self.annotations(want, content),
                "counts": self.counts(want, content),
            }
        )

    def serve_questions(self, want: str) -> None:
        """The document's question fields, each with the answers it already has.

        Questions live in the file and answers live in the store, so they are joined
        here rather than in either: a field the author deleted stops being asked, and
        its answer stays on record.
        """
        content = self.live_content(want)
        fields = q.parse_if_markdown(content, want) if content is not None else []
        answers: dict[str, list[dict]] = {}
        for view in self.annotations(want, content):
            if view["kind"] == "answer" and view["question_id"]:
                answers.setdefault(view["question_id"], []).append(view)

        out = [field | {"answers": answers.get(field["id"], [])} for field in fields]
        for field in out:
            field["answered"] = bool(field["answers"])
        self.send_json(
            {
                "questions": out,
                # Lines are only valid against this text; the page refetches on mismatch.
                "etag": etag_of(content) if content is not None else "",
                # Open questions and unresolved comments are counted apart because they
                # ask different things of a reader: one blocks the agent, one does not.
                "counts": self.counts(want, content)
                | {
                    "questions": len(out),
                    "open": sum(1 for field in out if not field["answered"]),
                },
            }
        )

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's casing
        """The write half: adding a comment or an answer, resolving, retrying.

        Everything a reader can do to annotation state is a POST under
        /api/annotations; the file tree itself stays read-only.
        """
        route, want = self.route_of(self.path)
        if route is None:
            return self.fail(HTTPStatus.NOT_FOUND, "not under this service's base path")

        try:
            body = self.read_body()
            if route == "/api/annotations":
                return self.add_annotation(body)
            if route.startswith("/api/annotations/threads/") and route.endswith("/reply"):
                thread = route[len("/api/annotations/threads/") : -len("/reply")]
                record = self.store.reply(
                    thread=thread,
                    text=str(body.get("text") or ""),
                    content_of=self.live_content,
                    by=str(body.get("by") or "agent"),
                )
                return self.send_json({"annotation": record.view()}, HTTPStatus.ACCEPTED)
            if route.startswith("/api/annotations/threads/") and route.endswith("/resolve"):
                thread = route[len("/api/annotations/threads/") : -len("/resolve")]
                updated = self.store.resolve(thread, bool(body.get("resolved", True)))
                return self.send_json({"thread": thread, "updated": updated})
            if route.startswith("/api/annotations/") and route.endswith("/retry"):
                annotation_id = route[len("/api/annotations/") : -len("/retry")]
                record = self.store.retry(annotation_id)
                return self.send_json({"annotation": record.view()})
        except _Unavailable as exc:
            return self.fail(HTTPStatus.NOT_IMPLEMENTED, str(exc))
        except ann.AnchorError as exc:
            # Not a 400: the request was well-formed and the file moved under it.
            return self.fail(HTTPStatus.CONFLICT, str(exc))
        except ann.AnnotationError as exc:
            return self.fail(HTTPStatus.BAD_REQUEST, str(exc))
        except ValueError as exc:
            return self.fail(HTTPStatus.BAD_REQUEST, str(exc))

        # The file routes exist and are readable, so a write to one is 405 rather
        # than 404: the tree itself stays read-only.
        if route in READ_ONLY_ROUTES or route.startswith("/static/") or route in ("/", "."):
            return self.fail(HTTPStatus.METHOD_NOT_ALLOWED, f"{route} is read-only")
        self.fail(HTTPStatus.NOT_FOUND, f"no route {route}")

    def do_DELETE(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's casing
        """Removing an annotation: the reader's way out of a comment they regret.

        Resolving says a discussion is finished and keeps it; this says it should not
        be in the record at all, so it is a different verb rather than another flag.
        """
        route, _ = self.route_of(self.path)
        if route is None:
            return self.fail(HTTPStatus.NOT_FOUND, "not under this service's base path")
        if not route.startswith("/api/annotations/") or route.count("/") != 3:
            return self.fail(HTTPStatus.NOT_FOUND, f"no route {route}")

        annotation_id = route[len("/api/annotations/") :]
        try:
            removed = self.store.delete(annotation_id)
        except _Unavailable as exc:
            return self.fail(HTTPStatus.NOT_IMPLEMENTED, str(exc))
        except ann.AnnotationError as exc:
            return self.fail(HTTPStatus.NOT_FOUND, str(exc))
        self.send_json({"deleted": removed})

    def add_annotation(self, body: dict) -> None:
        path = str(body.get("path") or "")
        content = self.live_content(path)
        if content is None:
            raise ann.AnchorError("the annotated file is not readable")
        asked = body.get("line")
        record = self.store.add(
            content=content,
            path=path,
            line=asked,
            quote=str(body.get("quote") or ""),
            text=str(body.get("text") or ""),
            kind=str(body.get("kind") or "comment"),
            thread=str(body.get("thread") or ""),
            question_id=str(body.get("question_id") or ""),
            by=str(body.get("by") or "reviewer"),
        )
        # Where the anchor actually landed, since `add` places it against live content
        # and the browser's line was only a hint.
        state = "ok" if record.line == asked else "moved"
        # 202, not 201: this viewer has recorded it, and the broker has not yet acked.
        self.send_json({"annotation": record.view(anchor_state=state)}, HTTPStatus.ACCEPTED)

    def read_body(self) -> dict:
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_BODY_BYTES:
            raise ValueError("body is too large")
        if not length:
            return {}
        parsed = json.loads(self.rfile.read(length) or b"{}")
        if not isinstance(parsed, dict):
            raise ValueError("body must be a JSON object")
        return parsed

    def route_of(self, raw: str) -> tuple[str | None, str]:
        """Split a request path into a base-relative route and its `path` query."""
        parsed = urllib.parse.urlsplit(raw)
        route = urllib.parse.unquote(parsed.path)
        base = self.cfg.base
        if base:
            if not (route == base or route.startswith(base + "/")):
                return None, ""
            route = route[len(base) :]
        want = (urllib.parse.parse_qs(parsed.query).get("path") or [""])[0]
        return posixpath.normpath(route or "/"), want

    @property
    def built(self) -> bool:
        return (self.cfg.static / "index.html").is_file()

    def serve_index(self) -> None:
        html = (self.cfg.static / "index.html").read_text() if self.built else UNBUILT_PAGE
        # The page is served under the proxy prefix, so it cannot know its own base
        # at build time; inject it rather than guessing from location.pathname.
        html = html.replace("{{BASE}}", self.cfg.base)
        # Injected into a JS string, so only plain http(s) URLs.
        url = self.cfg.conversation_url
        if not re.fullmatch(r"https?://[^\s\"'<>\\]+", url):
            url = ""
        html = html.replace("{{CONVERSATION_URL}}", url)
        self.send_body(HTTPStatus.OK, html.encode(), "text/html; charset=utf-8")

    def serve_static(self, name: str) -> None:
        self.send_asset(self.cfg.static, name)

    def send_asset(self, root: Path, name: str) -> None:
        target = (root / name).resolve()
        if root not in target.parents:
            raise ValueError("path escapes the asset directory")
        ctype, _ = mimetypes.guess_type(target.name)
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", ctype or "application/octet-stream")
        self.send_header("content-length", str(len(body)))
        # Vite content-hashes every asset name, so a cached one never goes stale.
        self.send_header("cache-control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(body)

    def serve_list(self, want: str) -> None:
        target = resolve(self.cfg.root, want)
        if not target.exists():
            raise FileNotFoundError(want)
        if not target.is_dir():
            return self.fail(HTTPStatus.BAD_REQUEST, "not a directory")
        self.send_json(listing(self.cfg.root, target))

    def serve_events(self, want: str) -> None:
        """Server-sent events for one open file: `file` when it changes on disk, `notes`
        when the annotation store takes any write. Each names what to refetch; the page
        then asks the ordinary routes, so the stream carries no data of its own."""
        target = resolve(self.cfg.root, want)

        def stamp() -> tuple[int, int] | None:
            try:
                st = target.stat()
                return (st.st_size, st.st_mtime_ns)
            except OSError:
                return None

        # A viewer without a store still streams file changes.
        store = getattr(self.server, "store", None)
        # Baselines before the headers: a client may write once they arrive.
        seen = stamp()
        gen = store.generation if store is not None else 0
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-store")
        # Nginx-style proxies buffer otherwise; the router already flushes at once.
        self.send_header("x-accel-buffering", "no")
        self.send_header("connection", "close")
        self.end_headers()
        self.close_connection = True

        closing = self.server.closing
        quiet = 0.0
        try:
            # The browser reconnects after this long, and the page refetches on reconnect.
            self.wfile.write(b"retry: 2000\n\n")
            self.wfile.flush()
            while not closing.is_set():
                if store is not None:
                    now = store.wait_change(gen, EVENTS_STAT_S)
                else:
                    closing.wait(EVENTS_STAT_S)
                    now = 0
                out = b""
                if now != gen:
                    gen = now
                    out += b"event: notes\ndata: {}\n\n"
                cur = stamp()
                if cur != seen:
                    seen = cur
                    out += b"event: file\ndata: {}\n\n"
                quiet = 0.0 if out else quiet + EVENTS_STAT_S
                if quiet >= EVENTS_HEARTBEAT_S:
                    out, quiet = b": keepalive\n\n", 0.0
                if out:
                    self.wfile.write(out)
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass  # The tab closed or navigated away.

    def serve_file(self, want: str) -> None:
        target = resolve(self.cfg.root, want)
        if not target.exists():
            raise FileNotFoundError(want)
        if not target.is_file():
            return self.fail(HTTPStatus.BAD_REQUEST, "not a file")
        view = read_file(self.cfg.root, target)
        # The page refetches with its etag; an unchanged file costs no body.
        etag = view.get("etag")
        if etag and self.headers.get("if-none-match", "").strip('"') == etag:
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("etag", f'"{etag}"')
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", "0")
            self.end_headers()
            return
        self.send_json(view)

    def serve_raw(self, want: str) -> None:
        """Bytes for an <img> in a rendered document, confined to image types."""
        target = resolve(self.cfg.root, want)
        if not target.exists():
            raise FileNotFoundError(want)
        if not target.is_file():
            return self.fail(HTTPStatus.BAD_REQUEST, "not a file")
        if target.suffix.lower() not in RAW_SUFFIXES:
            return self.fail(HTTPStatus.BAD_REQUEST, "not an image type this route serves")
        if target.stat().st_size > MAX_RAW_BYTES:
            return self.fail(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "image past the inline limit")
        ctype, _ = mimetypes.guess_type(target.name)
        body = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("content-type", ctype or "application/octet-stream")
        self.send_header("content-length", str(len(body)))
        # An SVG is a document: inert, or it runs script in the viewer's origin.
        self.send_header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(body)


class Server(ThreadingHTTPServer):
    # The proxy reconnects; a lingering socket on restart is worse than a dropped one.
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, cfg: Config, store: ann.Annotations | None = None):
        self.cfg = cfg
        self.store = store
        # Set on shutdown, so open event streams end instead of holding their threads.
        self.closing = threading.Event()
        super().__init__(("0.0.0.0", cfg.port), Handler)


    def shutdown(self) -> None:
        self.closing.set()
        super().shutdown()


def make_server(cfg: Config, store: ann.Annotations | None = None) -> Server:
    """A viewer, with an annotation store when one is configured.

    `store` is injected by the tests; otherwise it is built from the config, and its
    outbox is started only once the socket is up so a slow broker cannot delay serving
    the page.
    """
    if store is None and cfg.state is not None:
        store = ann.Annotations(
            state_path=cfg.state,
            root=cfg.root,
            transport=ann.BrokerTransport(cfg.broker_url, cfg.token_path),
            notifier=ann.SelfTransport(cfg.self_url, cfg.self_token_path, cfg.conversation_id),
        )
    return Server(cfg, store)


def main() -> None:
    cfg = Config.from_env()
    if not cfg.root.is_dir():
        raise SystemExit(f"files viewer: root {cfg.root} is not a directory")
    httpd = make_server(cfg)
    if httpd.store is not None:
        # After binding: a pull against a slow broker must not delay the first page.
        httpd.store.start()
    print(
        f"files-viewer listening on 0.0.0.0:{httpd.server_address[1]} "
        f"root={cfg.root} base={cfg.base or '/'}",
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()
