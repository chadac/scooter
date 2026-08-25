"""The structured-logging formatter: shape, extras merging, and error capture.

These guard the properties the convention actually depends on — a constant `msg`
with values as fields, a `conversation_id` spelled exactly that way, and a line
that survives values json.dumps would choke on.
"""

import json
import logging

import httpx
import pytest

from webhooks.logging_config import (
    JsonFormatter,
    PrettyFormatter,
    configure_logging,
    format_error,
)


def _record(msg="hello", level=logging.INFO, extra=None, name="webhooks.handlers.slack", exc_info=None):
    rec = logging.LogRecord(
        name=name, level=level, pathname=__file__, lineno=1, msg=msg, args=(), exc_info=exc_info
    )
    for k, v in (extra or {}).items():
        setattr(rec, k, v)
    return rec


def _emit(record) -> dict:
    return json.loads(JsonFormatter("webhooks").format(record))


# --- envelope ---------------------------------------------------------------


def test_emits_one_json_object_with_the_envelope():
    line = JsonFormatter("webhooks").format(_record("prompt queued"))
    assert "\n" not in line
    out = json.loads(line)
    assert out["service"] == "webhooks"
    assert out["level"] == "info"
    assert out["msg"] == "prompt queued"
    assert out["ts"]


def test_component_comes_from_extra():
    out = _emit(_record(extra={"component": "handlers.slack"}))
    assert out["component"] == "handlers.slack"


def test_component_falls_back_to_the_logger_name_minus_the_package():
    assert _emit(_record(name="webhooks.responses.jira"))["component"] == "responses.jira"
    assert _emit(_record(name="uvicorn.error"))["component"] == "uvicorn.error"


def test_level_is_the_records_severity():
    # warn/error, NOT Python's WARNING/CRITICAL. The level VALUE has to match the other
    # services or the natural cross-service query (level="warn") silently misses this one.
    assert _emit(_record(level=logging.ERROR))["level"] == "error"
    assert _emit(_record(level=logging.WARNING))["level"] == "warn"
    assert _emit(_record(level=logging.CRITICAL))["level"] == "error"


# --- extras -----------------------------------------------------------------


def test_extras_are_merged_as_top_level_fields():
    out = _emit(_record(extra={"conversation_id": "42bb375c", "queue_depth": 3}))
    assert out["conversation_id"] == "42bb375c"
    assert out["queue_depth"] == 3


def test_extras_cannot_clobber_the_envelope():
    # A field named `level` or `service` in an extra must NOT rewrite the
    # severity or the service of the line.
    out = _emit(_record(level=logging.ERROR, extra={"level": "debug", "service": "not-webhooks"}))
    assert out["level"] == "error"
    assert out["service"] == "webhooks"
    # ...and the caller's values are RENAMED, not dropped. Dropping loses data silently:
    # the caller passed them deliberately and gets no indication they vanished.
    assert out["field_level"] == "debug"
    assert out["field_service"] == "not-webhooks"


def test_standard_record_attributes_are_not_leaked_as_fields():
    out = _emit(_record())
    for noise in ("pathname", "lineno", "levelno", "args", "created", "threadName"):
        assert noise not in out


def test_an_unserializable_value_does_not_lose_the_line():
    class Exotic:
        def __repr__(self):
            return "<exotic>"

    out = _emit(_record("thing happened", extra={"conversation_id": "c1", "obj": Exotic()}))
    assert out["msg"] == "thing happened"
    assert out["conversation_id"] == "c1"
    assert out["obj"] == "<exotic>"


def test_a_circular_value_does_not_lose_the_line():
    loop: dict = {}
    loop["self"] = loop
    out = _emit(_record("thing happened", extra={"loop": loop}))
    assert out["msg"] == "thing happened"


def test_exception_info_is_attached():
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        out = _emit(_record(level=logging.ERROR, exc_info=sys.exc_info()))
    assert "ValueError: boom" in out["exception"]


# --- format_error -----------------------------------------------------------


def test_format_error_carries_message_and_type():
    out = format_error(ValueError("boom"))
    assert out == {"message": "boom", "type": "ValueError"}


def test_format_error_falls_back_to_repr_for_empty_httpx_errors():
    # THE reason this helper exists: several httpx transport exceptions
    # stringify to "", so f"failed: {e}" renders an unattributable line.
    e = httpx.ConnectError("")
    assert str(e) == ""
    out = format_error(e)
    assert out["type"] == "ConnectError"
    assert out["message"]  # NOT empty


def test_format_error_lifts_the_status_off_an_http_status_error():
    request = httpx.Request("GET", "https://example.test/x")
    e = httpx.HTTPStatusError("503", request=request, response=httpx.Response(503, request=request))
    out = format_error(e)
    assert out["status"] == 503
    assert out["type"] == "HTTPStatusError"


def test_format_error_lifts_a_code():
    e = OSError(2, "No such file")
    out = format_error(e)
    assert out["code"] == 2


def test_format_error_records_the_cause():
    try:
        try:
            raise ValueError("root")
        except ValueError as inner:
            raise RuntimeError("outer") from inner
    except RuntimeError as e:
        out = format_error(e)
    assert out["cause"]["type"] == "ValueError"
    assert out["cause"]["message"] == "root"


def test_format_error_survives_a_str_that_raises():
    class Nasty(Exception):
        def __str__(self):
            raise RuntimeError("nope")

    out = format_error(Nasty())
    assert out["type"] == "Nasty"
    assert out["message"]


# --- configure_logging ------------------------------------------------------


def test_configure_logging_installs_json_when_forced(monkeypatch, capsys):
    monkeypatch.setenv("LOG_FORMAT", "json")
    configure_logging("webhooks", "INFO")
    try:
        logging.getLogger("webhooks.store").info(
            "stored mapping", extra={"component": "store", "conversation_id": "c1"}
        )
        out = json.loads(capsys.readouterr().out.strip())
        assert out["msg"] == "stored mapping"
        assert out["component"] == "store"
        assert out["conversation_id"] == "c1"
        assert out["service"] == "webhooks"
    finally:
        logging.getLogger().handlers.clear()


def test_configure_logging_honors_pretty(monkeypatch, capsys):
    monkeypatch.setenv("LOG_FORMAT", "pretty")
    configure_logging("webhooks", "INFO")
    try:
        logging.getLogger("webhooks.store").info(
            "stored mapping", extra={"component": "store", "conversation_id": "c1"}
        )
        line = capsys.readouterr().out.strip()
        assert "[store] stored mapping" in line
        assert "conversation_id=c1" in line
    finally:
        logging.getLogger().handlers.clear()


def test_json_is_the_default_in_a_container(monkeypatch, capsys):
    monkeypatch.delenv("LOG_FORMAT", raising=False)
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
    configure_logging("webhooks", "INFO")
    try:
        logging.getLogger("webhooks.store").info("x", extra={"component": "store"})
        json.loads(capsys.readouterr().out.strip())
    finally:
        logging.getLogger().handlers.clear()


def test_log_level_env_is_honored(monkeypatch, capsys):
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    configure_logging("webhooks")
    try:
        log = logging.getLogger("webhooks.store")
        log.info("dropped", extra={"component": "store"})
        log.warning("kept", extra={"component": "store"})
        lines = [x for x in capsys.readouterr().out.strip().splitlines() if x]
        assert len(lines) == 1
        assert json.loads(lines[0])["msg"] == "kept"
    finally:
        logging.getLogger().handlers.clear()


def test_configure_logging_does_not_stack_handlers(monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    configure_logging("webhooks", "INFO")
    configure_logging("webhooks", "INFO")
    try:
        assert len(logging.getLogger().handlers) == 1
    finally:
        logging.getLogger().handlers.clear()


def test_an_unknown_level_falls_back_to_info(monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    configure_logging("webhooks", "NONSENSE")
    try:
        assert logging.getLogger().level == logging.INFO
    finally:
        logging.getLogger().handlers.clear()


def test_pretty_formatter_renders_an_exception():
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        line = PrettyFormatter().format(
            _record(level=logging.ERROR, exc_info=sys.exc_info(), extra={"component": "store"})
        )
    assert "[store]" in line
    assert "ValueError: boom" in line


@pytest.mark.parametrize(
    "level,expected",
    [(logging.DEBUG, "debug"), (logging.INFO, "info"), (logging.ERROR, "error")],
)
def test_levels_are_lowercased(level, expected):
    assert _emit(_record(level=level))["level"] == expected
