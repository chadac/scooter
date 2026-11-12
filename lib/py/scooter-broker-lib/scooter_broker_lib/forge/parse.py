"""Reading forge requests: which path is git vs API, which repo it names, a push's ref updates and a GraphQL body's operations."""

from __future__ import annotations

import json
import re
import zlib
from dataclasses import dataclass
from typing import Protocol, runtime_checkable
from urllib.parse import parse_qs, unquote

from .policy import GraphQLOperation, Kind, RefUpdate


@runtime_checkable
class ForgeDialect(Protocol):
    """A forge's API shape, supplied by the contrib that owns the forge."""

    def api_repo(self, path: str) -> str | None:
        """The repo an API path names, or None."""
        ...

    def is_graphql(self, path: str) -> bool:
        ...


@dataclass(frozen=True)
class GenericDialect:
    """No repo or GraphQL knowledge: requests classify by path alone."""

    def api_repo(self, path: str) -> str | None:
        return None

    def is_graphql(self, path: str) -> bool:
        return False

# `/<repo>[.git]/<smart-HTTP or LFS endpoint>`; <repo> may be nested (GitLab groups).
_GIT_PATH = re.compile(
    r"^/(?P<repo>[^?]+?)(?:\.git)?/(?P<rest>info/refs|git-upload-pack|git-receive-pack|info/lfs(?:/.*)?)$"
)


@dataclass(frozen=True)
class Classified:
    kind: Kind
    repo: str | None = None
    git_service: str | None = None


def classify(
    *, dialect: ForgeDialect, git: bool, api_prefixes: tuple[str, ...], path: str, query: str = ""
) -> Classified:
    """Classify one request on a forge host from its path; `git`/`api_prefixes` say what the host serves."""
    if git:
        m = _GIT_PATH.match(path)
        if m:
            rest = m.group("rest")
            if rest == "info/refs":
                service = (parse_qs(query).get("service") or [None])[0]
            elif rest.startswith("info/lfs"):
                service = "git-lfs"
            else:
                service = rest
            return Classified("git", unquote(m.group("repo")).strip("/"), service)
    if any(path.startswith(p) for p in api_prefixes):
        return Classified("api", dialect.api_repo(path))
    return Classified("web")


# ---------------------------------------------------------------------------
# git-receive-pack: the ref updates at the head of a push
# ---------------------------------------------------------------------------

class PushHeadReader:
    """Accumulate a receive-pack request body until its command list ends (the first flush-pkt).

    `feed` returns the ref updates once the list is complete, else None. A body it
    cannot read (gzip it cannot inflate, malformed pkt-lines, a push certificate)
    sets `failed`, so the caller hands the policy `ref_updates=None`.
    """

    def __init__(self, gzipped: bool = False) -> None:
        self._raw = b""
        self._inflater = zlib.decompressobj(16 + zlib.MAX_WBITS) if gzipped else None
        self.failed = False
        self.updates: tuple[RefUpdate, ...] | None = None

    def feed(self, chunk: bytes) -> tuple[RefUpdate, ...] | None:
        if self.failed or self.updates is not None:
            return self.updates
        try:
            self._raw += self._inflater.decompress(chunk) if self._inflater else chunk
        except zlib.error:
            self.failed = True
            return None
        try:
            done, updates = _parse_commands(self._raw)
        except ValueError:
            self.failed = True
            return None
        if done:
            self.updates = updates
        return self.updates


def _parse_commands(data: bytes) -> tuple[bool, tuple[RefUpdate, ...]]:
    """(complete, updates) for the pkt-line command list at the head of `data`."""
    updates: list[RefUpdate] = []
    i = 0
    while True:
        if len(data) - i < 4:
            return False, tuple(updates)
        try:
            n = int(data[i:i + 4], 16)
        except ValueError as e:
            raise ValueError("bad pkt-line length") from e
        if n == 0:
            return True, tuple(updates)
        if n < 4:
            raise ValueError("bad pkt-line length")
        if len(data) - i < n:
            return False, tuple(updates)
        line = data[i + 4:i + n].split(b"\0", 1)[0].rstrip(b"\n").decode("utf-8", "replace")
        i += n
        if line.startswith("shallow "):
            continue
        if line.startswith("push-cert"):
            raise ValueError("push certificates are not parsed")
        parts = line.split(" ")
        if len(parts) != 3:
            raise ValueError(f"bad command line {line!r}")
        updates.append(RefUpdate(*parts))


# ---------------------------------------------------------------------------
# GraphQL: operation types and top-level fields
# ---------------------------------------------------------------------------

_TOKEN = re.compile(
    r'''(?P<ws>[\s,﻿]+|\#[^\n\r]*)
      |(?P<block>"""(?:\\"""|[^"]|"(?!""))*""")
      |(?P<str>"(?:\\.|[^"\\\n])*")
      |(?P<spread>\.\.\.)
      |(?P<name>[_A-Za-z][_0-9A-Za-z]*)
      |(?P<num>-?\d[\d.eE+-]*)
      |(?P<punct>[!$&()\:=@\[\]{}|])''',
    re.VERBOSE,
)


def _tokenize(doc: str) -> list[str]:
    out: list[str] = []
    pos = 0
    while pos < len(doc):
        m = _TOKEN.match(doc, pos)
        if not m:
            raise ValueError(f"unexpected character at {pos}")
        pos = m.end()
        if m.lastgroup == "ws":
            continue
        # Strings are kept as one opaque token so their contents never look like syntax.
        out.append('"' if m.lastgroup in ("str", "block") else m.group())
    return out


class _Parser:
    def __init__(self, tokens: list[str]) -> None:
        self.t = tokens
        self.i = 0

    @property
    def tok(self) -> str:
        if self.i >= len(self.t):
            raise ValueError("unexpected end of document")
        return self.t[self.i]

    def done(self) -> bool:
        return self.i >= len(self.t)

    def take(self, expected: str | None = None) -> str:
        tok = self.tok
        if expected is not None and tok != expected:
            raise ValueError(f"expected {expected!r}, got {tok!r}")
        self.i += 1
        return tok

    def skip_balanced(self, open_: str, close: str) -> None:
        self.take(open_)
        depth = 1
        while depth:
            tok = self.take()
            depth += (tok == open_) - (tok == close)

    def skip_directives(self) -> None:
        while not self.done() and self.tok == "@":
            self.take()
            self.take()
            if not self.done() and self.tok == "(":
                self.skip_balanced("(", ")")

    def selection_set(self) -> list[tuple[str, str]]:
        """Top-level items: ("field", name) or ("spread", fragment); inline fragments are flattened in."""
        items: list[tuple[str, str]] = []
        self.take("{")
        while self.tok != "}":
            if self.tok == "...":
                self.take()
                if self.tok == "on":
                    self.take()
                    self.take()
                    self.skip_directives()
                    items.extend(self.selection_set())
                elif self.tok in ("@", "{"):
                    self.skip_directives()
                    items.extend(self.selection_set())
                else:
                    items.append(("spread", self.take()))
                    self.skip_directives()
                continue
            name = self.take()
            if self.tok == ":":
                self.take()
                name = self.take()
            if self.tok == "(":
                self.skip_balanced("(", ")")
            self.skip_directives()
            if self.tok == "{":
                self.skip_balanced("{", "}")
            items.append(("field", name))
        self.take("}")
        return items


def parse_graphql(document: str) -> tuple[GraphQLOperation, ...]:
    """Every operation in a document, with fragment spreads at the root expanded; raises ValueError when unreadable."""
    p = _Parser(_tokenize(document))
    raw_ops: list[tuple[str, str | None, list[tuple[str, str]]]] = []
    fragments: dict[str, list[tuple[str, str]]] = {}
    while not p.done():
        tok = p.tok
        if tok == "{":
            raw_ops.append(("query", None, p.selection_set()))
        elif tok in ("query", "mutation", "subscription"):
            p.take()
            name = None
            if p.tok not in ("(", "@", "{"):
                name = p.take()
            if p.tok == "(":
                p.skip_balanced("(", ")")
            p.skip_directives()
            raw_ops.append((tok, name, p.selection_set()))
        elif tok == "fragment":
            p.take()
            name = p.take()
            p.take("on")
            p.take()
            p.skip_directives()
            fragments[name] = p.selection_set()
        else:
            raise ValueError(f"unexpected {tok!r} at top level")
    if not raw_ops:
        raise ValueError("no operation")

    def expand(items: list[tuple[str, str]], seen: frozenset[str]) -> list[str]:
        out: list[str] = []
        for kind, name in items:
            if kind == "field":
                out.append(name)
            elif name not in seen:
                if name not in fragments:
                    raise ValueError(f"unknown fragment {name!r}")
                out.extend(expand(fragments[name], seen | {name}))
        return out

    return tuple(
        GraphQLOperation(type=t, name=n, fields=tuple(dict.fromkeys(expand(items, frozenset()))))  # type: ignore[arg-type]
        for t, n, items in raw_ops
    )


def parse_graphql_body(body: bytes) -> tuple[GraphQLOperation, ...] | None:
    """The operations of a JSON GraphQL request (single or batched), or None when unreadable."""
    try:
        payload = json.loads(body)
        batch = payload if isinstance(payload, list) else [payload]
        ops: list[GraphQLOperation] = []
        for item in batch:
            query = item.get("query") if isinstance(item, dict) else None
            if not isinstance(query, str):
                return None
            ops.extend(parse_graphql(query))
        return tuple(ops)
    except (ValueError, AttributeError):
        return None
