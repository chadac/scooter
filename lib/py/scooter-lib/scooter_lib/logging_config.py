"""Structured logging for every Scooter Python service.

WHY. The lines this replaces were prose with values interpolated into them:

    aws notify: POST http://... returned 404 for req-abc123 — NOT retrying

Readable by a human tailing logs, useless to a tool. You cannot ask "show me
everything that happened to conversation 42bb375c" — which is the question worth
asking, and the one that has cost the most time.

THE SHAPE. One JSON object per line:

    {"ts":"…","level":"info","service":"broker","component":"providers.aws",
     "msg":"notify raised approval interrupt","conversation_id":"42bb375c-…",
     "request_id":"req-abc123"}

This mirrors services/agent-host/src/log.ts exactly, field for field, so a Loki
query written for one service works against the other. `component` is the
existing `[bracket]`/module prefix promoted to a queryable field; `msg` is a
SHORT CONSTANT string with no interpolation, because a constant msg is groupable
and an interpolated one is not.

HOW VALUES GET THERE. The stdlib's `extra=` kwarg, which stamps arbitrary
attributes onto the LogRecord:

    logger.info("prompt queued", extra={"conversation_id": cid})
    logger.error("comment post failed", extra={"error": format_error(e)})

The formatter merges those attributes into the JSON object. No new dependency,
no logging call-site wrapper: `logging.getLogger(__name__)` keeps working, and
third-party libraries' records (uvicorn, httpx, boto3) come out in the same
shape for free.

OUTPUT. stdout, one line each. NOT an OTel exporter: this cluster's collector
(Alloy, via the k8s-monitoring chart) already scrapes pod logs into Loki, so
stdout IS the ingestion path.

DEV. A human tailing logs locally gets the pretty renderer instead
(LOG_FORMAT=pretty, the default when not in a container). JSON is for the
collector, not for people.

SERVICE-AGNOSTIC. `service` and the `component` prefix are parameters, not
constants — that is the whole reason this lives in `scooter_lib` rather than in
one app. See PR #567 for the three drifted copies this replaced.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

# The name our handler is tagged with. A re-configure replaces exactly this
# handler and leaves anything the host application installed (pytest's caplog)
# alone; stacking a second one would double every line.
HANDLER_NAME = "scooter-structured"

# Attributes the stdlib puts on EVERY LogRecord. Anything on a record that is not
# in here was passed by the caller via `extra=` (or is a formatter-computed field
# we add below), and so belongs in the JSON object as a context field.
#
# Built by construction rather than hand-listing: a stdlib version that adds a
# record attribute would otherwise start leaking it into every log line.
_STANDARD_ATTRS = frozenset(
    vars(
        logging.LogRecord(
            name="", level=0, pathname="", lineno=0, msg="", args=(), exc_info=None
        )
    )
) | {
    # Set by Logger.makeRecord AFTER __init__, so not visible above.
    "message",
    "asctime",
    "taskName",
}

# The envelope. A caller's `extra={"level": ...}` must never overwrite the real
# level — extras are merged around these, not over them.
_RESERVED = ("ts", "level", "service", "component", "msg")

# Level VALUES must match across every service, or the natural cross-service query
# (level="warn") silently misses whole services. Python's levelname is
# WARNING/CRITICAL; the fleet convention is warn/error, matching agent-host's
# TypeScript Level union.
_LEVEL_NAMES = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}

# Cyclic data must cost a truncated field, never the line. A `__cause__` chain or
# a self-referential dict would otherwise recurse until RecursionError.
_MAX_DEPTH = 8


def format_error(exc: BaseException | None, _depth: int = 0) -> dict[str, Any]:
    """Serialize a caught exception into something with actual content.

    `str(e)` is the reflex, and it is wrong here: several httpx transport
    exceptions (ConnectError, ReadTimeout, ConnectTimeout raised from the
    underlying anyio/socket error) carry an EMPTY message, so a line built as
    f"...: {e}" renders as "...: " and the failure becomes unattributable.
    repr() and the type name are the fallbacks that always say something.

    Also lifts the fields HTTP/AWS/k8s clients hang off the exception —
    status/status_code/code/errno, httpx's `.response.status_code`, botocore's
    `response["Error"]["Code"]` — so a 404 vs a 403 is a queryable field rather
    than a substring of prose.
    """
    if exc is None:
        return {}

    message = ""
    try:
        message = str(exc)
    except Exception:  # a broken __str__ must not take the log line with it
        message = ""
    if not message:
        # httpx.ConnectError("") and friends. repr() at least names the class and
        # any args; the bare type name is the last resort.
        try:
            message = repr(exc)
        except Exception:
            message = ""
    if not message:
        message = type(exc).__name__

    out: dict[str, Any] = {"message": message, "type": type(exc).__name__}

    # Whatever the client library chose to name it. `status` and `code` are the
    # two the convention pins down; the rest map onto them.
    for attr, key in (
        ("status", "status"),
        ("status_code", "status"),
        ("code", "code"),
        ("errno", "code"),
    ):
        if key in out:
            continue
        value = getattr(exc, attr, None)
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            out[key] = value

    response = getattr(exc, "response", None)

    # httpx.HTTPStatusError hangs the Response off the exception rather than
    # carrying a status itself — the single most common error shape in webhooks.
    if "status" not in out:
        status = getattr(response, "status_code", None)
        if isinstance(status, int):
            out["status"] = status

    # botocore ClientError: the useful code is buried in response["Error"]["Code"].
    if isinstance(response, dict):
        if "code" not in out:
            error = response.get("Error")
            if isinstance(error, dict):
                error_code = error.get("Code")
                if isinstance(error_code, (str, int)):
                    out["code"] = error_code
        if "status" not in out:
            metadata = response.get("ResponseMetadata")
            if isinstance(metadata, dict):
                status_code = metadata.get("HTTPStatusCode")
                if isinstance(status_code, int):
                    out["status"] = status_code

    cause = exc.__cause__
    if cause is not None and cause is not exc and _depth < _MAX_DEPTH:
        out["cause"] = format_error(cause, _depth + 1)

    return out


def _coerce(value: Any, _depth: int = 0) -> Any:
    """Make one field value JSON-safe without ever raising.

    A log line must survive an unserializable value — dropping the line is a
    far worse outcome than dropping one field's fidelity.
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if _depth >= _MAX_DEPTH:
        # Cyclic or absurdly nested. Truncate the field, keep the line.
        try:
            return repr(value)
        except Exception:
            return f"<unserializable {type(value).__name__}>"
    if isinstance(value, (list, tuple, set)):
        return [_coerce(v, _depth + 1) for v in value]
    if isinstance(value, dict):
        return {str(k): _coerce(v, _depth + 1) for k, v in value.items()}
    if isinstance(value, BaseException):
        return format_error(value)
    if isinstance(value, datetime):
        return value.isoformat()
    try:
        return str(value)
    except Exception:
        return f"<unserializable {type(value).__name__}>"


def _extras(record: logging.LogRecord) -> dict[str, Any]:
    """The caller's `extra=` fields, and nothing else."""
    return {
        key: value
        for key, value in vars(record).items()
        if key not in _STANDARD_ATTRS and not key.startswith("_")
    }


def _component(record: logging.LogRecord, prefix: str | None) -> str:
    """The record's component field.

    An explicit `extra={"component": ...}` wins; otherwise the logger name with
    the owning service's package prefix stripped, so `broker.providers.aws` logs
    as `providers.aws` while a third-party record (`uvicorn.error`) keeps its own
    name.
    """
    explicit = getattr(record, "component", None)
    if isinstance(explicit, str) and explicit:
        return explicit
    name = record.name
    if prefix and name.startswith(prefix):
        return name[len(prefix) :]
    return name


def _prefix_for(service: str | None) -> str | None:
    """`broker` -> `broker.`. The package a service's loggers are named under."""
    return f"{service}." if service else None


class JsonFormatter(logging.Formatter):
    """One JSON object per line: ts, level, service, component, msg + extras."""

    def __init__(self, service: str, component_prefix: str | None = None) -> None:
        super().__init__()
        self.service = service
        # Defaults to the service's own package, which is the case for every
        # in-tree service; a contrib whose modules live elsewhere passes its own.
        self.component_prefix = (
            component_prefix if component_prefix is not None else _prefix_for(service)
        )

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": _LEVEL_NAMES.get(record.levelno, record.levelname.lower()),
            "service": self.service,
            "component": _component(record, self.component_prefix),
            "msg": record.getMessage(),
        }

        for key, value in _extras(record).items():
            # Never let an extra shadow the envelope: a caller's stray
            # extra={"msg": ...} would otherwise silently replace the real msg.
            # RENAMED, never dropped — the caller passed it deliberately and a
            # silent drop gives them no indication it vanished.
            if key in _RESERVED:
                key = f"field_{key}"
            line[key] = _coerce(value)

        # logger.exception()/exc_info=True. Structured, not a text blob appended
        # after the JSON (which would break one-object-per-line parsing).
        if record.exc_info and record.exc_info[1] is not None:
            error = line.get("error")
            if not isinstance(error, dict):
                error = format_error(record.exc_info[1])
                line["error"] = error
            error.setdefault("stack", self.formatException(record.exc_info))

        # stack_info=True is the caller asking for the CALL site, which is a
        # different question from the traceback above (`error.stack`).
        if record.stack_info:
            line["stack"] = self.formatStack(record.stack_info)

        try:
            return json.dumps(line, default=str)
        except Exception:
            # _coerce should have made this impossible; if it did not, emit the
            # envelope rather than losing the event entirely.
            return json.dumps(
                {key: line.get(key) for key in _RESERVED}
                | {"fields": "[unserializable]"},
                default=str,
            )


class PrettyFormatter(logging.Formatter):
    """`[component] msg key=value` — the familiar shape, for a human at a terminal."""

    def __init__(self, service: str | None = None, component_prefix: str | None = None) -> None:
        super().__init__()
        self.service = service
        self.component_prefix = (
            component_prefix if component_prefix is not None else _prefix_for(service)
        )

    def format(self, record: logging.LogRecord) -> str:
        fields = " ".join(
            f"{key}={_render(_coerce(value))}"
            for key, value in sorted(_extras(record).items())
        )
        level = _LEVEL_NAMES.get(record.levelno, record.levelname.lower())
        head = f"{level:<5} [{_component(record, self.component_prefix)}] {record.getMessage()}"
        text = f"{head} {fields}" if fields else head
        if record.exc_info:
            text = f"{text}\n{self.formatException(record.exc_info)}"
        return text


def _render(value: Any) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str)
    return str(value)


def use_json() -> bool:
    """JSON in a container, human-readable at a terminal.

    KUBERNETES_SERVICE_HOST is injected by k8s into every pod, so this picks the
    right default with no configuration.
    """
    fmt = os.environ.get("LOG_FORMAT", "").strip().lower()
    if fmt == "json":
        return True
    if fmt == "pretty":
        return False
    return os.environ.get("KUBERNETES_SERVICE_HOST") is not None


def configure_logging(
    service_name: str,
    level: str | None = None,
    *,
    component_prefix: str | None = None,
) -> None:
    """Install the structured formatter on the ROOT logger.

    Root, not the service's own logger, so uvicorn's and sqlalchemy's lines land
    in the same format — a collector parsing a stream that is half JSON and half
    prose gets neither.

    Idempotent: replaces our own previously-installed handler rather than
    stacking a second one (which would double every line). Handlers the host
    application installed — pytest's caplog above all — are left alone.
    """
    raw = (level or os.environ.get("LOG_LEVEL") or "INFO").strip().upper()
    # getLevelNamesMapping(), not getLevelName(): the str -> int direction of
    # getLevelName is deprecated and returns "Level FOO" for an unknown name
    # rather than failing, which made an isinstance guard load-bearing.
    resolved = logging.getLevelNamesMapping().get(raw, logging.INFO)

    formatter: logging.Formatter = (
        JsonFormatter(service_name, component_prefix)
        if use_json()
        else PrettyFormatter(service_name, component_prefix)
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    handler.set_name(HANDLER_NAME)

    root = logging.getLogger()
    for existing in list(root.handlers):
        # Ours, plus whatever basicConfig left behind (a bare StreamHandler).
        # `type(...) is` deliberately excludes subclasses, which is what keeps
        # pytest's LogCaptureHandler installed.
        if existing.get_name() == HANDLER_NAME or type(existing) is logging.StreamHandler:
            root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(resolved)


def get_logger(service: str, component: str) -> logging.Logger:
    """A logger whose name encodes the component.

    `get_logger("scheduler", "spawn")` -> `scheduler.spawn`, which the formatter
    renders as component="spawn".
    """
    return logging.getLogger(f"{service}.{component}")
