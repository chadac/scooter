"""Structured JSON logging for the scheduler service.

WHY. The lines this replaces were prose with values interpolated into them:

    logger.error("spawn failed: HTTP %s for task %r", resp.status_code, title)

Readable to a human tailing logs, useless to a tool. You cannot ask "show me every
spawn failure" (the rendered msg differs per status code and title), and you cannot
ask "show me everything that happened to conversation 42bb375c" at all, because the
id never made it into the line as a queryable value.

THE SHAPE. One JSON object per line:

    {"ts":"…","level":"error","service":"scheduler","component":"spawn",
     "msg":"create failed","status":500,"task_title":"nightly report"}

`msg` is a SHORT CONSTANT. Every varying value is a field. A constant msg is
groupable; an interpolated one is a cardinality explosion.

`component` is the module (or the `[bracket]` prefix a line already used), promoted
to a field.

OUTPUT. stdout/stderr, one line each. NOT the OTel SDK: the cluster's collector
(Alloy, via the k8s-monitoring chart) already scrapes pod logs into Loki, so stdout
IS the ingestion path and needs no new dependency or exporter. This mirrors the
TypeScript side, services/agent-host/src/log.ts — same field names, same defaults,
so a cross-service query on `conversation_id` joins the two.

DEV. A human tailing logs locally gets the pretty renderer instead
(LOG_FORMAT=pretty, the default when not in a container). JSON is for the collector,
not for people.

USAGE.

    from .logging_config import format_error, get_logger

    logger = get_logger("spawn")
    logger.info("prompt queued", extra={"conversation_id": cid})
    logger.error("spawn failed", extra={"error": format_error(e)})
"""

from __future__ import annotations

import datetime as _datetime
import json
import logging
import os
from typing import Any

# Attributes the stdlib puts on every LogRecord. Anything NOT in here arrived via the
# caller's `extra=` kwarg and is therefore a field we want in the JSON. Enumerating the
# builtins is the only way to recover the extras: the stdlib merges them straight into
# the record's __dict__ without recording which ones it added.
_RESERVED: frozenset[str] = frozenset(
    {
        "args",
        "asctime",
        "created",
        "exc_info",
        "exc_text",
        "filename",
        "funcName",
        "levelname",
        "levelno",
        "lineno",
        "module",
        "msecs",
        "message",
        "msg",
        "name",
        "pathname",
        "process",
        "processName",
        "relativeCreated",
        "stack_info",
        "taskName",
        "thread",
        "threadName",
    }
)

# The envelope. A caller's extra= must never overwrite these — if it tries, the value is
# preserved under a suffixed key rather than silently dropped or silently winning.
_ENVELOPE: tuple[str, ...] = ("ts", "level", "service", "component", "msg")


def format_error(exc: BaseException) -> dict[str, Any]:
    """Serialize an exception into a dict with actual content.

    Use this instead of interpolating `str(e)`. Two reasons:

    1. `str()` on several httpx transport exceptions returns the EMPTY STRING —
       httpx.ConnectError, ReadTimeout, ConnectTimeout and friends are routinely
       raised with no message, so `logger.error("spawn failed: %s", e)` renders
       "spawn failed: " and the actual failure is unattributable. The fallback here
       is repr(), then the type name, so a line always says what went wrong.
    2. Transport and HTTP errors hang the useful bits (status, code) off the
       exception object rather than the message.

    Returns keys: message, type, and — when present — status and code.
    """
    try:
        message = str(exc)
    except Exception:  # a __str__ that itself raises must not lose the log line
        message = ""

    if not message:
        # str() gave us nothing (the httpx transport-exception case). repr() usually
        # carries the class name and any args; the bare type name is the last resort.
        try:
            message = repr(exc)
        except Exception:
            message = ""
    if not message:
        message = type(exc).__name__

    out: dict[str, Any] = {"message": message, "type": type(exc).__name__}

    # An httpx.HTTPStatusError carries .response.status_code; other clients hang a
    # status/status_code/code directly off the exception. Take whichever exists.
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(exc, "status", None)
    if status is not None:
        out["status"] = status

    code = getattr(exc, "code", None)
    if code is None:
        code = getattr(exc, "errno", None)
    if code is not None:
        out["code"] = code

    return out


def _safe(value: Any) -> Any:
    """Coerce a value into something json.dumps will accept.

    An unserializable field must degrade to its repr, never take the whole line down —
    a log call is not allowed to raise inside the code it is observing.
    """
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, dict):
        return {str(k): _safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_safe(v) for v in value]
    try:
        return repr(value)
    except Exception:
        return "<unrepresentable>"


# Level VALUES must match across every service, or the natural cross-service query
# (level="warn") silently misses whole services. Python's levelname is WARNING/CRITICAL;
# the fleet convention is warn/error, matching agent-host's TypeScript logger.
_LEVEL_NAMES = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}


class JsonFormatter(logging.Formatter):
    """Renders one JSON object per line: ts, level, service, component, msg + extras.

    `component` comes from an explicit extra={"component": …} when given, otherwise
    from the logger name with the service prefix stripped ("scheduler.spawn" ->
    "spawn"), which is what get_logger() produces.
    """

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def _component(self, record: logging.LogRecord) -> str:
        explicit = getattr(record, "component", None)
        if isinstance(explicit, str) and explicit:
            return explicit
        name = record.name
        prefix = f"{self.service}."
        if name.startswith(prefix):
            return name[len(prefix) :]
        return name

    def _extras(self, record: logging.LogRecord) -> dict[str, Any]:
        return {
            key: value
            for key, value in record.__dict__.items()
            # A leading underscore marks a private/internal attribute (and "component"
            # is consumed as part of the envelope, not repeated as a field).
            if key not in _RESERVED and key != "component" and not key.startswith("_")
        }

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "ts": _datetime.datetime.fromtimestamp(
                record.created, tz=_datetime.timezone.utc
            ).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": _LEVEL_NAMES.get(record.levelno, record.levelname.lower()),
            "service": self.service,
            "component": self._component(record),
            # record.getMessage() applies %-args. New call sites pass a constant msg and
            # no args, but this keeps a stray legacy line (or a library's) intact.
            "msg": record.getMessage(),
        }

        for key, value in self._extras(record).items():
            # Never clobber the envelope. Rule 3 of the convention depends on
            # `service`/`component`/`msg` meaning the same thing on every line.
            line[f"{key}_" if key in _ENVELOPE else key] = _safe(value)

        # logger.exception() / exc_info=True. The traceback is a field, not a set of
        # bare extra lines appended after the JSON object — which would break the
        # one-object-per-line contract the collector parses on.
        if record.exc_info:
            exc = record.exc_info[1]
            if isinstance(exc, BaseException) and "error" not in line:
                line["error"] = _safe(format_error(exc))
            line["stack"] = self.formatException(record.exc_info)
        if record.stack_info:
            line["stack_info"] = self.formatStack(record.stack_info)

        try:
            return json.dumps(line, default=repr)
        except Exception:
            # _safe() should have made this unreachable; if a __repr__ raises anyway,
            # emit the envelope rather than losing the event. Re-spreading the fields
            # here would re-include whatever just failed.
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
    """`[component] msg key=value` — for a human tailing logs at a terminal."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service
        self._json = JsonFormatter(service)

    def format(self, record: logging.LogRecord) -> str:
        component = self._json._component(record)
        extras = self._json._extras(record)
        rendered = " ".join(
            f"{key}={value if isinstance(value, str) else json.dumps(_safe(value), default=repr)}"
            for key, value in extras.items()
        )
        line = f"[{component}] {record.getMessage()}"
        if rendered:
            line = f"{line} {rendered}"
        if record.exc_info:
            line = f"{line}\n{self.formatException(record.exc_info)}"
        return line


def _json_output() -> bool:
    """JSON in a container, human-readable at a terminal. KUBERNETES_SERVICE_HOST is
    set by k8s in every pod, so this picks the right default without configuration."""
    fmt = os.environ.get("LOG_FORMAT", "").lower()
    if fmt == "json":
        return True
    if fmt == "pretty":
        return False
    return os.environ.get("KUBERNETES_SERVICE_HOST") is not None


def _level(default: str) -> int:
    raw = (os.environ.get("LOG_LEVEL") or default).upper()
    # getLevelNamesMapping(), not getLevelName(): the str -> int direction of
    # getLevelName is deprecated (the docs call it a mistake) and returns the string
    # "Level FOO" for an unknown name rather than failing, so an isinstance guard was
    # load-bearing. An explicit mapping lookup says what it means. (3.11+, and
    # pyproject already requires >=3.11.)
    return logging.getLevelNamesMapping().get(raw, logging.INFO)


def configure_logging(service_name: str, *, default_level: str = "INFO") -> None:
    """Install the structured handler on the root logger.

    Replaces logging.basicConfig. Root (not just "scheduler") so uvicorn's and
    sqlalchemy's lines land in the same format — a collector parsing a stream that is
    half JSON and half prose gets neither.

    Idempotent: re-running swaps the handler rather than stacking a second one, so a
    test that calls it repeatedly does not get duplicate lines.
    """
    formatter: logging.Formatter = (
        JsonFormatter(service_name) if _json_output() else PrettyFormatter(service_name)
    )

    handler = logging.StreamHandler()
    handler.setFormatter(formatter)
    handler.set_name("scooter-structured")

    root = logging.getLogger()
    for existing in list(root.handlers):
        # Drop our own previous handler and anything basicConfig left behind; leave a
        # pytest/caplog handler alone so test capture keeps working.
        if existing.get_name() == "scooter-structured" or type(existing) is logging.StreamHandler:
            root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(_level(default_level))


def get_logger(component: str, *, service: str = "scheduler") -> logging.Logger:
    """A logger whose name encodes the component, e.g. get_logger("spawn") ->
    "scheduler.spawn", which the formatter renders as component="spawn"."""
    return logging.getLogger(f"{service}.{component}")
