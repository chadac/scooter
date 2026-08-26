"""Structured logging for the warm-store controller — the Python side of the convention
already shipped for TypeScript in services/agent-host/src/log.ts.

WHY. The lines this service emitted were prose with values interpolated into them:

    2026-08-25 12:00:01 INFO relabel warm-store-a1b2 -> ready {'scooter.io/pool-state': ...}

Readable by a human tailing logs, useless to a tool. You cannot ask "show me everything
that happened to conversation 42bb375c" or "how often does a clean-marker read fail",
because every line is a distinct string. A CONSTANT msg plus fields is groupable; an
interpolated one is not.

THE SHAPE. One JSON object per line:

    {"ts":"…","level":"info","service":"warm-store-controller","component":"loop",
     "msg":"relabel pool PVC","pvc":"warm-store-a1b2","state":"ready"}

`component` is the module (or the `[bracket]` prefix a line already carried), promoted to
a field.

HOW FIELDS GET THERE. The standard `extra=` kwarg — no new logging API to learn, and
anything already holding a stdlib logger keeps working:

    logger.info("prompt queued", extra={"conversation_id": cid})

OUTPUT. stdout, one line each. NOT the OTel SDK: this cluster's collector (Alloy, via the
k8s-monitoring chart) already scrapes pod logs into Loki, so stdout IS the ingestion path.

DEV. A human tailing logs locally gets the pretty renderer instead (LOG_FORMAT=pretty,
the default when not in a container).
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

# The envelope keys the formatter owns. An `extra=` field with one of these names must not
# clobber the envelope — the whole point of the convention is that `ts`/`level`/`service`/
# `component`/`msg` mean exactly one thing across every service.
_RESERVED = ("ts", "level", "service", "component", "msg")

# stdlib spells it WARNING; the convention (and the TypeScript side) spells it `warn`, and a
# cross-service query on level only works if both agree.
_LEVEL_NAMES = {"warning": "warn", "critical": "error", "fatal": "error"}

# Attributes present on EVERY LogRecord. Anything on a record that is not one of these (and
# not private) came from the caller's `extra=`, which is how extras are recovered without
# asking callers to wrap them in a envelope of their own.
_STANDARD_RECORD_ATTRS = frozenset(
    {
        "args", "asctime", "created", "exc_info", "exc_text", "filename", "funcName",
        "levelname", "levelno", "lineno", "module", "msecs", "message", "msg", "name",
        "pathname", "process", "processName", "relativeCreated", "stack_info",
        "stacklevel", "thread", "threadName", "taskName",
    }
)


def format_error(exc: BaseException) -> dict[str, Any]:
    """Serialize a caught exception into something with actual content.

    NEVER interpolate `str(e)` into a message. Two reasons, both bite in this service:

      1. it makes the msg unique per failure, so the line stops being groupable;
      2. `str()` on several httpx / urllib3 transport exceptions returns the EMPTY STRING
         (they define no args), which is how a failure becomes literally unattributable in
         the logs. So the message falls back to `repr()`, then to the type name.

    `status` and `code` are lifted out when present: the kubernetes client hangs the HTTP
    status off `ApiException.status`, and OS/urllib3 errors carry `errno`/`code`. Having
    them as top-level fields is what makes "show me the 409s" a query rather than a grep.
    """
    message = ""
    try:
        message = str(exc)
    except Exception:  # noqa: BLE001 — a __str__ that raises must not lose the log line
        message = ""
    if not message:
        try:
            message = repr(exc)
        except Exception:  # noqa: BLE001
            message = ""
    if not message:
        message = type(exc).__name__

    out: dict[str, Any] = {"message": message, "type": type(exc).__name__}

    for attr, key in (("status", "status"), ("code", "code"), ("errno", "code")):
        if key in out:
            continue
        value = getattr(exc, attr, None)
        if value is not None:
            out[key] = value

    # k8s ApiException carries the server's explanation here and nowhere else.
    reason = getattr(exc, "reason", None)
    if reason is not None:
        out["reason"] = reason

    return out


def _jsonable(value: Any) -> Any:
    """Best-effort coercion so ONE unserializable field can never drop the whole line."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        try:
            return repr(value)
        except Exception:  # noqa: BLE001
            return "[unserializable]"


class JsonFormatter(logging.Formatter):
    """Emits one JSON object per line: the envelope, then the record's `extra=` fields."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        line: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat().replace("+00:00", "Z"),
            "level": _LEVEL_NAMES.get(record.levelname.lower(), record.levelname.lower()),
            "service": self.service,
            # A logger created as logging.getLogger(__name__) already names the module, so
            # it is the natural default component; an explicit extra={"component": …} wins.
            "component": record.name.rsplit(".", 1)[-1],
            "msg": record.getMessage(),
        }

        for key, value in record.__dict__.items():
            if key in _STANDARD_RECORD_ATTRS or key.startswith("_"):
                continue
            if key in _RESERVED and key != "component":
                # Never let a caller's field shadow the envelope; keep it under a safe name
                # rather than dropping the value on the floor.
                line[f"field_{key}"] = _jsonable(value)
                continue
            line[key] = _jsonable(value)

        if record.exc_info and record.exc_info[1] is not None and "error" not in line:
            # logger.exception(...) — attach the structured error rather than a stack blob
            # glued onto the end of the message, and keep the traceback as its own field.
            line["error"] = format_error(record.exc_info[1])
            line["error"]["stack"] = self.formatException(record.exc_info)
        elif record.exc_info:
            line["stack"] = self.formatException(record.exc_info)

        try:
            return json.dumps(line, default=repr)
        except (TypeError, ValueError):
            # Belt and braces: _jsonable already coerced the fields, so reaching here means
            # something exotic. Emit the envelope rather than losing the event entirely.
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
    """The familiar `[component] message key=value` shape, for a human at a terminal."""

    def format(self, record: logging.LogRecord) -> str:  # noqa: A003
        component = getattr(record, "component", None) or record.name.rsplit(".", 1)[-1]
        fields = {
            key: value
            for key, value in record.__dict__.items()
            if key not in _STANDARD_RECORD_ATTRS
            and not key.startswith("_")
            and key not in _RESERVED
        }
        extra = " ".join(f"{k}={v}" for k, v in fields.items())
        head = f"[{component}] {record.getMessage()}"
        line = f"{head} {extra}" if extra else head
        if record.exc_info:
            line = f"{line}\n{self.formatException(record.exc_info)}"
        return line


def _use_json() -> bool:
    """JSON in a container, human-readable at a terminal. KUBERNETES_SERVICE_HOST is set by
    k8s in every pod, so this picks the right default without configuration."""
    fmt = os.environ.get("LOG_FORMAT", "").lower()
    if fmt == "json":
        return True
    if fmt == "pretty":
        return False
    return os.environ.get("KUBERNETES_SERVICE_HOST") is not None


def configure_logging(service_name: str) -> None:
    """Install the structured handler on the root logger. Replaces logging.basicConfig.

    Idempotent: re-running (a test, a re-entrant main) replaces the handler instead of
    stacking a second one and double-printing every line.
    """
    level_name = os.environ.get("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, None)
    if not isinstance(level, int):
        level = logging.INFO

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter(service_name) if _use_json() else PrettyFormatter())

    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level)
