"""Structured logging for the broker.

WHY. Today's lines are prose with values interpolated into them:

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
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone

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
_RESERVED = frozenset({"ts", "level", "service", "component", "msg"})

_LEVEL_NAMES = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",  # "warn", to match agent-host's Level union
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}


def format_error(exc: BaseException | None) -> dict:
    """Serialize a caught exception into something with actual content.

    `str(e)` is the reflex, and it is wrong here: several httpx transport
    exceptions (ConnectError, ReadTimeout, ConnectTimeout raised from the
    underlying anyio/socket error) carry an EMPTY message, so a line built as
    f"...: {e}" renders as "...: " and the failure becomes unattributable.
    repr() and the type name are the fallbacks that always say something.

    Also lifts the fields HTTP/AWS/k8s clients hang off the exception —
    status/status_code/code — so a 404 vs a 403 is a queryable field rather
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
            message = type(exc).__name__

    out: dict = {"message": message, "type": type(exc).__name__}

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

    # botocore ClientError: the useful code is buried in response["Error"]["Code"].
    if "code" not in out:
        response = getattr(exc, "response", None)
        if isinstance(response, dict):
            error = response.get("Error")
            if isinstance(error, dict):
                error_code = error.get("Code")
                if isinstance(error_code, (str, int)):
                    out["code"] = error_code
            status_code = None
            metadata = response.get("ResponseMetadata")
            if isinstance(metadata, dict):
                status_code = metadata.get("HTTPStatusCode")
            if "status" not in out and isinstance(status_code, int):
                out["status"] = status_code

    cause = exc.__cause__
    if cause is not None and cause is not exc:
        out["cause"] = format_error(cause)

    return out


def _coerce(value):
    """Make one field value JSON-safe without ever raising.

    A log line must survive an unserializable value — dropping the line is a
    far worse outcome than dropping one field's fidelity.
    """
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple, set)):
        return [_coerce(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _coerce(v) for k, v in value.items()}
    if isinstance(value, BaseException):
        return format_error(value)
    if isinstance(value, datetime):
        return value.isoformat()
    try:
        return str(value)
    except Exception:
        return f"<unserializable {type(value).__name__}>"


def _extras(record: logging.LogRecord) -> dict:
    """The caller's `extra=` fields, and nothing else."""
    return {
        key: value
        for key, value in vars(record).items()
        if key not in _STANDARD_ATTRS and not key.startswith("_")
    }


class JsonFormatter(logging.Formatter):
    """One JSON object per line: ts, level, service, component, msg + extras."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        line = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat(),
            "level": _LEVEL_NAMES.get(record.levelno, record.levelname.lower()),
            "service": self.service,
            "component": _component(record),
            "msg": record.getMessage(),
        }

        for key, value in _extras(record).items():
            # Never let an extra shadow the envelope: a caller's stray
            # extra={"msg": ...} would otherwise silently replace the real msg.
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

        try:
            return json.dumps(line, default=str)
        except Exception:
            # _coerce should have made this impossible; if it did not, emit the
            # envelope rather than losing the event entirely.
            return json.dumps(
                {
                    "ts": line["ts"],
                    "level": line["level"],
                    "service": line["service"],
                    "component": line["component"],
                    "msg": line["msg"],
                    "fields": "[unserializable]",
                }
            )


class PrettyFormatter(logging.Formatter):
    """`[component] msg key=value` — the familiar shape, for a human at a terminal."""

    def format(self, record: logging.LogRecord) -> str:
        fields = " ".join(
            f"{key}={_render(_coerce(value))}"
            for key, value in sorted(_extras(record).items())
        )
        level = _LEVEL_NAMES.get(record.levelno, record.levelname.lower())
        head = f"{level:<5} [{_component(record)}] {record.getMessage()}"
        text = f"{head} {fields}" if fields else head
        if record.exc_info:
            text = f"{text}\n{self.formatException(record.exc_info)}"
        return text


def _render(value) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value, default=str)
    return str(value)


def _component(record: logging.LogRecord) -> str:
    """The record's component field.

    An explicit `extra={"component": ...}` wins; otherwise the logger name with
    the package prefix stripped, so `broker.providers.aws` logs as
    `providers.aws` and a third-party record (`uvicorn.error`) keeps its own name.
    """
    explicit = getattr(record, "component", None)
    if isinstance(explicit, str) and explicit:
        return explicit
    name = record.name
    if name.startswith("broker."):
        return name[len("broker.") :]
    return name


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


def configure_logging(service_name: str = "broker") -> None:
    """Install the structured formatter on the root logger.

    Replaces logging.basicConfig at the service entrypoint. Idempotent: calling
    it twice replaces the handler rather than stacking a second one (which would
    double every line).
    """
    level_name = os.environ.get("LOG_LEVEL", "").strip().upper()
    level = getattr(logging, level_name, None)
    if not isinstance(level, int):
        level = logging.INFO

    formatter: logging.Formatter = (
        JsonFormatter(service_name) if use_json() else PrettyFormatter()
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)
    # Tag it so a re-configure can find and replace exactly our handler, leaving
    # anything the host application installed (e.g. pytest's caplog) alone.
    handler.set_name("broker-structured")

    root = logging.getLogger()
    for existing in list(root.handlers):
        if existing.get_name() == "broker-structured":
            root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)
