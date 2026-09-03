"""Structured logging for the conversation-controller — the Python side of the convention
already shipped for TypeScript in services/agent-host/src/log.ts.

WHY. Today's lines are prose with the values interpolated into them:

    2026-08-24 17:26:01,004 INFO assigned 42bb375c-… -> agent-host-1 @ 10.42.0.9 (gen 3)

Readable by a human tailing logs, useless to a tool. You cannot ask "show me everything
that happened to conversation 42bb375c" across the controller AND the agent-host — which
is the question worth asking, and the one that has cost the most time.

THE SHAPE. One JSON object per line:

    {"ts":"…","level":"info","service":"conversation-controller","component":"loop",
     "msg":"assigned","conversation_id":"42bb375c-…","host_pod":"agent-host-1",
     "host_ip":"10.42.0.9","generation":3}

`component` is the existing `[bracket]`/module identity promoted to a field, and `msg` is a
SHORT CONSTANT string — a constant msg is groupable, an interpolated one is not. Every
varying value becomes a field, passed through the stdlib's own `extra=` kwarg so no call
site needs a bespoke logger object:

    logger.info("assigned", extra={"conversation_id": name, "host_pod": pod})

FIELD NAMES. snake_case, and the conversation id is ALWAYS exactly `conversation_id` —
not conv_name, not name. The cross-service query depends on that exact spelling.

OUTPUT. stdout, one line each. NOT the OTel SDK: this cluster's collector (Alloy, via the
k8s-monitoring chart) already scrapes pod logs into Loki, so stdout IS the ingestion path
and needs no new dependency or exporter.

DEV. A human tailing logs locally gets the pretty renderer instead (LOG_FORMAT=pretty, the
default when not in a container). JSON is for the collector, not for people.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timezone
from typing import Any

# Attributes the stdlib puts on EVERY LogRecord. Anything on a record that is not in here
# was passed by the caller via `extra=` (or is one of our own envelope fields), and is what
# we want to emit. Built from a real record rather than hand-listing, plus the few the
# stdlib only sets sometimes (taskName is 3.12+; asctime appears once a Formatter runs).
_STANDARD_RECORD_FIELDS = frozenset(
    vars(
        logging.LogRecord(
            name="", level=logging.INFO, pathname="", lineno=0, msg="", args=(), exc_info=None
        )
    )
) | {"asctime", "message", "taskName"}

# Envelope fields we emit ourselves. `component` is CONSUMED into the envelope rather than
# renamed (it is how every call site passes it); the rest are renamed on collision so the
# value survives without corrupting the envelope. Note `msg`/`name`/`args`/`levelname` can
# never reach us — the stdlib's makeRecord raises KeyError on those before the formatter runs.
_CONSUMED = frozenset({"component"})
_RESERVED = frozenset({"ts", "level", "service", "msg"})

_LEVEL_NAMES = {
    logging.DEBUG: "debug",
    logging.INFO: "info",
    logging.WARNING: "warn",  # "warn", to match the TS convention (console.warn -> warn)
    logging.ERROR: "error",
    logging.CRITICAL: "error",
}


def format_error(exc: BaseException | None) -> dict[str, Any]:
    """Serialize a caught exception into something with actual content.

    A bare `str(e)` is the trap this replaces. Several httpx / urllib transport exceptions
    (ConnectError, ReadTimeout, and TimeoutError itself) stringify to the EMPTY STRING, so
    an interpolated `%s` renders a failure as nothing at all — literally unattributable.
    We fall back to repr() and always carry the type name, and we pick up the status/code
    attributes that k8s + HTTP clients hang off their errors.
    """
    if exc is None:
        return {"message": "", "type": "NoneType"}

    message = ""
    try:
        message = str(exc)
    except Exception:  # noqa: BLE001 — a broken __str__ must not lose the log line
        message = ""
    if not message:
        # str() was empty (the httpx/TimeoutError case) — repr() at least names the type
        # and any constructor args.
        try:
            message = repr(exc)
        except Exception:  # noqa: BLE001
            message = type(exc).__name__

    out: dict[str, Any] = {"message": message, "type": type(exc).__name__}

    # k8s ApiException carries .status/.reason/.body; urllib carries .code/.reason;
    # OSError carries .errno. Keep whatever is actually there, and only if scalar-ish.
    for attr in ("status", "code", "reason", "errno"):
        value = getattr(exc, attr, None)
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            out[attr] = value
        else:
            out[attr] = str(value)

    cause = exc.__cause__ or exc.__context__
    if cause is not None and cause is not exc:
        out["cause"] = format_error(cause)

    return out


def _jsonable(value: Any) -> Any:
    """Best-effort coercion so ONE unserializable field can never lose the whole line."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, BaseException):
        return format_error(value)
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(v) for v in value]
    try:
        return str(value)
    except Exception:  # noqa: BLE001
        return "[unserializable]"


def _merge_extras(record: logging.LogRecord, line: dict[str, Any]) -> None:
    """Fold the caller's `extra=` fields into `line` WITHOUT clobbering the envelope.

    A collision (someone passes extra={"msg": …}) is renamed rather than dropped, so the
    value survives and the envelope stays trustworthy.
    """
    for key, value in vars(record).items():
        if key in _STANDARD_RECORD_FIELDS or key in _CONSUMED:
            continue
        if key.startswith("_"):
            continue
        out_key = f"field_{key}" if key in _RESERVED else key
        line[out_key] = _jsonable(value)


class JsonFormatter(logging.Formatter):
    """One JSON object per line: ts, level, service, component, msg + the caller's fields."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {
            "ts": datetime.fromtimestamp(record.created, timezone.utc).isoformat().replace(
                "+00:00", "Z"
            ),
            "level": _LEVEL_NAMES.get(record.levelno, record.levelname.lower()),
            "service": self.service,
            # `component` is normally passed via extra=; the logger NAME is the fallback so a
            # third-party library's line (kubernetes, urllib3) is still attributable.
            "component": getattr(record, "component", None) or record.name,
            "msg": record.getMessage(),
        }
        _merge_extras(record, line)

        # logger.exception() / exc_info=True: attach the structured error, not a raw
        # traceback blob glued onto the message. An explicit extra={"error": …} wins.
        if record.exc_info and record.exc_info[1] is not None and "error" not in line:
            line["error"] = format_error(record.exc_info[1])
        if record.exc_info:
            line["stack"] = self.formatException(record.exc_info)

        try:
            return json.dumps(line, default=str)
        except (TypeError, ValueError):
            # A field defeated even default=str. Never lose the line: rebuild from the
            # envelope alone (re-including the payload would just fail again).
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
    """Human-readable rendering for a terminal: the familiar `[component] msg k=v` shape."""

    def __init__(self, service: str) -> None:
        super().__init__()
        self.service = service

    def format(self, record: logging.LogRecord) -> str:
        line: dict[str, Any] = {}
        _merge_extras(record, line)
        # Read `component` off the record, NOT out of `line` — _merge_extras consumes it
        # into the envelope, so it is never present in `line`.
        component = getattr(record, "component", None) or record.name
        conversation_id = line.pop("conversation_id", None)

        if record.exc_info and record.exc_info[1] is not None and "error" not in line:
            line["error"] = format_error(record.exc_info[1])

        head = f"[{component}]"
        if conversation_id:
            head += f" conv={str(conversation_id)[:8]}"
        fields = " ".join(
            f"{k}={v if isinstance(v, (str, int, float, bool)) else json.dumps(_jsonable(v), default=str)}"
            for k, v in line.items()
        )
        out = f"{record.levelname:<7} {head} {record.getMessage()}"
        if fields:
            out += f" {fields}"
        if record.exc_info:
            out += "\n" + self.formatException(record.exc_info)
        return out


def _json_output() -> bool:
    """JSON in a container, human-readable at a terminal. KUBERNETES_SERVICE_HOST is set by
    k8s in every pod, so this picks the right default without configuration."""
    fmt = os.environ.get("LOG_FORMAT", "").lower()
    if fmt == "json":
        return True
    if fmt == "pretty":
        return False
    return os.environ.get("KUBERNETES_SERVICE_HOST") is not None


def _level() -> int:
    raw = os.environ.get("LOG_LEVEL", "").upper()
    if raw == "WARN":
        raw = "WARNING"
    if raw in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
        return getattr(logging, raw)
    return logging.INFO


def configure_logging(service_name: str = "conversation-controller") -> None:
    """Install the structured handler on the ROOT logger, replacing whatever is there.

    Root (not our own logger) so third-party lines — the kubernetes client, urllib3 — go
    through the same formatter and land in Loki as parseable JSON too. Idempotent: calling
    it twice does not double every line.
    """
    formatter: logging.Formatter = (
        JsonFormatter(service_name) if _json_output() else PrettyFormatter(service_name)
    )
    # stdout for everything: the collector reads both streams, and splitting by level would
    # interleave a single pass's lines across two pipes.
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(_level())



# --- warn-once ---------------------------------------------------------------

_warned: set[str] = set()


def warn_once(logger: logging.Logger, key: str, msg: str, extra: dict[str, Any]) -> None:
    """Warn the first time `key` is seen, debug after. For a condition re-detected every
    tick: loud once per resource, never a flood. `forget_warned` re-arms it."""
    repeat = key in _warned
    _warned.add(key)
    if repeat:
        logger.debug(msg, extra={**extra, "repeat_suppressed": True})
    else:
        logger.warning(msg, extra=extra)


def forget_warned(keep: set[str] | None = None) -> None:
    """Re-arm keys no longer active, so a condition that clears and returns is loud
    again. No argument forgets everything (tests)."""
    if keep is None:
        _warned.clear()
        return
    _warned.intersection_update(keep)
