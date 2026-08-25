"""Structured logging for the webhooks service.

WHY. Today's lines are prose with values interpolated into them:

    Failed to post GitHub comment on acme/widgets#42: ReadTimeout

Readable by a human tailing logs, useless to a tool. You cannot ask "show me
everything that happened to conversation 42bb375c" — which is the question worth
asking. So: one JSON object per line, a SHORT CONSTANT `msg`, and every varying
value as its own field.

    {"ts":"…","level":"info","service":"webhooks","component":"handlers.slack",
     "msg":"prompt queued","conversation_id":"42bb375c-…"}

This mirrors services/agent-host/src/log.ts so the two services' lines join on
the same field names — `conversation_id` is spelled exactly that way on both
sides, which is what makes a cross-service query possible at all.

HOW YOU USE IT. Stock stdlib logging plus the `extra=` kwarg:

    logger.info("prompt queued", extra={"conversation_id": cid})
    logger.error("comment post failed", extra={"error": format_error(e), ...})

No custom logger class, no adapter: `extra=` is the standard hook, so third-party
libraries logging through the same handler are formatted correctly too.

OUTPUT. stdout, one line each. NOT the OTel SDK: the cluster's collector already
scrapes pod logs, so stdout IS the ingestion path. A human at a terminal gets the
pretty renderer instead (LOG_FORMAT=pretty, the default outside a container).
"""

from __future__ import annotations

import json
import logging
import os
import sys
from typing import Any

# LogRecord attributes that are NOT caller extras. Anything on a record that is
# not in here was put there by `extra=` (or by a filter) and belongs in the JSON.
# Taken from logging.LogRecord.__init__ plus the few the stdlib bolts on later.
_RESERVED = frozenset(
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

# The envelope. Caller extras must never clobber these — a field named `level`
# in an extra would otherwise silently rewrite the severity of the line.
_ENVELOPE = ("ts", "level", "service", "component", "msg")


def format_error(exc: BaseException) -> dict[str, Any]:
    """Serialize a caught exception into something with actual content.

    `str(e)` is NOT good enough. Several httpx transport exceptions
    (ConnectError, ReadTimeout, …) carry an empty string as their message, so
    `f"failed: {e}"` renders as `failed: ` — an unattributable line, and exactly
    the failure mode this convention exists to kill. Fall back to repr(), and
    always carry the type name so the class of failure survives regardless.

    Status/code are lifted out when present (httpx.HTTPStatusError hangs the
    response off the exception; asyncpg uses `.code`, OSError uses `.errno`)
    because "which status did it return" is the first question asked of any of
    these lines.
    """
    message = ""
    try:
        message = str(exc)
    except Exception:  # a __str__ that raises must not take the log line with it
        message = ""
    if not message:
        # httpx transport errors stringify to "". repr() at least names the type
        # and any args; if that is empty too, the type name always is not.
        try:
            message = repr(exc)
        except Exception:
            message = ""
    if not message:
        message = type(exc).__name__

    out: dict[str, Any] = {"message": message, "type": type(exc).__name__}

    # httpx.HTTPStatusError / anything holding a response with a status code.
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None)
    if status is None:
        status = getattr(exc, "status", None) or getattr(exc, "status_code", None)
    if status is not None:
        out["status"] = status

    # `code` (asyncpg, and various clients) or `errno` (OSError) — the same
    # question under two spellings, normalized onto one field.
    code = getattr(exc, "code", None)
    if code is None:
        code = getattr(exc, "errno", None)
    if code is not None:
        out["code"] = code

    cause = exc.__cause__
    if cause is not None and cause is not exc:
        out["cause"] = {"message": str(cause) or repr(cause), "type": type(cause).__name__}

    return out


def _safe(value: Any) -> Any:
    """Coerce a value into something json.dumps will accept.

    A log line must never be lost to an unserializable field — that turns a
    diagnostic into a second, worse incident.
    """
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        try:
            return repr(value)
        except Exception:
            return "<unserializable>"


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
    """One JSON object per line: envelope first, then the caller's extras."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": _LEVEL_NAMES.get(record.levelno, record.levelname.lower()),
            "service": self.service,
            # `component` rides in via extra=; the logger name (module path minus
            # the package prefix) is the fallback, which is what the [bracket]
            # prefixes already were.
            "component": getattr(record, "component", None) or _component_from_name(record.name),
            "msg": record.getMessage(),
        }

        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith("_"):
                continue
            # A caller field that collides with an envelope key is RENAMED, never dropped.
            # Dropping it loses data silently — the caller passed it deliberately and gets
            # no indication it vanished. field_<key> matches the other Python services.
            if key in _ENVELOPE:
                line[f"field_{key}"] = _safe(value)
                continue
            if key == "component":
                continue
            line[key] = _safe(value)

        if record.exc_info:
            line["exception"] = self.formatException(record.exc_info)
        if record.stack_info:
            line["stack"] = self.formatStack(record.stack_info)

        try:
            return json.dumps(line)
        except (TypeError, ValueError):
            # Belt and braces: _safe() already ran over every extra, so getting
            # here means something exotic in the envelope. Emit the envelope
            # alone rather than dropping the line.
            return json.dumps(
                {k: _safe(line.get(k)) for k in _ENVELOPE} | {"fields": "[unserializable]"}
            )


class PrettyFormatter(logging.Formatter):
    """`[component] message key=value` — for a human tailing logs locally."""

    def format(self, record: logging.LogRecord) -> str:
        component = getattr(record, "component", None) or _component_from_name(record.name)
        extras = " ".join(
            f"{k}={v if isinstance(v, (str, int, float)) else json.dumps(_safe(v))}"
            for k, v in record.__dict__.items()
            if k not in _RESERVED and k not in _ENVELOPE and k != "component" and not k.startswith("_")
        )
        base = f"{record.levelname:<5} [{component}] {record.getMessage()}"
        if extras:
            base = f"{base} {extras}"
        if record.exc_info:
            base = f"{base}\n{self.formatException(record.exc_info)}"
        return base


def _component_from_name(name: str) -> str:
    """`webhooks.handlers.slack` -> `handlers.slack`."""
    if name.startswith("webhooks."):
        return name[len("webhooks.") :]
    return name


def _json_output() -> bool:
    """JSON in a container, human-readable at a terminal.

    KUBERNETES_SERVICE_HOST is set by k8s in every pod, so this picks the right
    default without configuration.
    """
    fmt = os.environ.get("LOG_FORMAT", "").lower()
    if fmt == "json":
        return True
    if fmt == "pretty":
        return False
    return os.environ.get("KUBERNETES_SERVICE_HOST") is not None


def configure_logging(service_name: str, level: str | None = None) -> None:
    """Install the structured formatter on the root logger.

    Replaces logging.basicConfig(). Idempotent: it REPLACES the root handlers
    rather than adding to them, so calling it twice (app import + uvicorn
    reload) does not double every line.
    """
    raw = (level or os.environ.get("LOG_LEVEL") or "INFO").upper()
    resolved = getattr(logging, raw, None)
    if not isinstance(resolved, int):
        resolved = logging.INFO

    formatter: logging.Formatter = (
        JsonFormatter(service_name) if _json_output() else PrettyFormatter()
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(resolved)
