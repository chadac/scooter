"""The structured-logging formatter: shape, extras merging, and error capture.

These guard the properties the convention actually depends on — a constant `msg`
with values as fields, a `conversation_id` spelled exactly that way, and a line
that survives values json.dumps would choke on.

They run parameterized over more than one service name because the whole point
of this module living in `scooter_lib` is that `service` and the `component`
prefix are parameters: a test that only ever says "webhooks" would not catch a
constant re-hardcoded in the formatter.
"""

import json
import logging
from datetime import datetime, timezone

import httpx
import pytest

from scooter_lib.logging_config import (
    HANDLER_NAME,
    JsonFormatter,
    PrettyFormatter,
    configure_logging,
    format_error,
    get_logger,
)


def _record(
    msg="hello",
    level=logging.INFO,
    extra=None,
    name="webhooks.handlers.slack",
    exc_info=None,
    stack_info=None,
):
    rec = logging.LogRecord(
        name=name, level=level, pathname=__file__, lineno=1, msg=msg, args=(), exc_info=exc_info
    )
    rec.stack_info = stack_info
    for k, v in (extra or {}).items():
        setattr(rec, k, v)
    return rec


def _emit(record, service="webhooks") -> dict:
    return json.loads(JsonFormatter(service).format(record))


@pytest.fixture(autouse=True)
def _clean_root_handlers():
    """configure_logging touches the root logger; don't leak that between tests."""
    root = logging.getLogger()
    before = list(root.handlers)
    level = root.level
    yield
    root.handlers[:] = before
    root.setLevel(level)


# --- envelope ---------------------------------------------------------------


def test_emits_one_json_object_with_the_envelope():
    line = JsonFormatter("webhooks").format(_record("prompt queued"))
    assert "\n" not in line
    out = json.loads(line)
    assert out["service"] == "webhooks"
    assert out["level"] == "info"
    assert out["msg"] == "prompt queued"
    assert out["ts"]


def test_ts_is_utc_iso8601():
    record = _record()
    out = _emit(record)
    assert datetime.fromisoformat(out["ts"]) == datetime.fromtimestamp(
        record.created, timezone.utc
    )


def test_component_comes_from_extra():
    out = _emit(_record(extra={"component": "handlers.slack"}))
    assert out["component"] == "handlers.slack"


@pytest.mark.parametrize(
    "service,name,expected",
    [
        # The prefix stripped is the SERVICE's own package, not a constant.
        ("webhooks", "webhooks.responses.jira", "responses.jira"),
        ("broker", "broker.providers.aws", "providers.aws"),
        ("scheduler", "scheduler.spawn", "spawn"),
        # A third-party record keeps its own name whatever the service is.
        ("broker", "uvicorn.error", "uvicorn.error"),
        # ...and so does another service's logger: only OUR prefix comes off.
        ("broker", "webhooks.responses.jira", "webhooks.responses.jira"),
    ],
)
def test_component_falls_back_to_the_logger_name_minus_the_service_package(
    service, name, expected
):
    assert _emit(_record(name=name), service=service)["component"] == expected


def test_component_prefix_can_be_overridden_for_a_contrib():
    # A contrib's modules are not under the service's package, so it names its own.
    formatter = JsonFormatter("broker", component_prefix="acme_provider.")
    out = json.loads(formatter.format(_record(name="acme_provider.transports.x")))
    assert out["component"] == "transports.x"


def test_level_is_the_records_severity():
    # warn/error, NOT Python's WARNING/CRITICAL. The level VALUE has to match the other
    # services or the natural cross-service query (level="warn") silently misses this one.
    assert _emit(_record(level=logging.ERROR))["level"] == "error"
    assert _emit(_record(level=logging.WARNING))["level"] == "warn"
    assert _emit(_record(level=logging.CRITICAL))["level"] == "error"


@pytest.mark.parametrize(
    "level,expected",
    [(logging.DEBUG, "debug"), (logging.INFO, "info"), (logging.ERROR, "error")],
)
def test_levels_are_lowercased(level, expected):
    assert _emit(_record(level=level))["level"] == expected


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


def test_a_datetime_extra_is_rendered_as_iso8601():
    when = datetime(2026, 9, 21, 12, 0, tzinfo=timezone.utc)
    assert _emit(_record(extra={"expires_at": when}))["expires_at"] == when.isoformat()


def test_an_exception_extra_is_rendered_as_a_structured_error():
    out = _emit(_record(extra={"error": ValueError("boom")}))
    assert out["error"] == {"message": "boom", "type": "ValueError"}


def test_an_unserializable_value_does_not_lose_the_line():
    class Exotic:
        def __repr__(self):
            return "<exotic>"

        def __str__(self):
            return "<exotic>"

    out = _emit(_record("thing happened", extra={"conversation_id": "c1", "obj": Exotic()}))
    assert out["msg"] == "thing happened"
    assert out["conversation_id"] == "c1"
    assert out["obj"] == "<exotic>"


def test_a_circular_value_does_not_lose_the_line():
    # The depth guard earns its keep here: a naive recursive coercion blows the
    # stack and takes the whole line with it.
    loop: dict = {}
    loop["self"] = loop
    out = _emit(_record("thing happened", extra={"loop": loop}))
    assert out["msg"] == "thing happened"
    assert out["loop"]


def test_exception_info_is_attached_as_a_structured_error_with_a_stack():
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        out = _emit(_record(level=logging.ERROR, exc_info=sys.exc_info()))
    assert out["error"]["type"] == "ValueError"
    assert out["error"]["message"] == "boom"
    assert "ValueError: boom" in out["error"]["stack"]


def test_an_explicit_error_extra_wins_over_exc_info_but_still_gets_the_stack():
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        out = _emit(
            _record(
                level=logging.ERROR,
                exc_info=sys.exc_info(),
                extra={"error": {"message": "what the caller meant", "type": "Curated"}},
            )
        )
    assert out["error"]["type"] == "Curated"
    assert "ValueError: boom" in out["error"]["stack"]


def test_stack_info_lands_in_its_own_field():
    # stack_info is the CALL site, a different question from the traceback.
    out = _emit(_record(stack_info="Stack (most recent call last):\n  <call site>"))
    assert "<call site>" in out["stack"]
    assert "error" not in out


# --- format_error -----------------------------------------------------------


def test_format_error_carries_message_and_type():
    out = format_error(ValueError("boom"))
    assert out == {"message": "boom", "type": "ValueError"}


def test_format_error_of_none_is_empty():
    assert format_error(None) == {}


def test_format_error_falls_back_to_repr_for_empty_httpx_errors():
    # THE reason this helper exists: several httpx transport exceptions
    # stringify to "", so f"failed: {e}" renders an unattributable line.
    e = httpx.ConnectError("")
    assert str(e) == ""
    out = format_error(e)
    assert out["type"] == "ConnectError"
    assert out["message"]  # NOT empty


def test_format_error_lifts_the_status_off_an_http_status_error():
    # httpx hangs the Response off the exception rather than carrying a status
    # itself — the most common error shape in the webhooks service.
    request = httpx.Request("GET", "https://example.test/x")
    e = httpx.HTTPStatusError("503", request=request, response=httpx.Response(503, request=request))
    out = format_error(e)
    assert out["status"] == 503
    assert out["type"] == "HTTPStatusError"


def test_format_error_lifts_a_code():
    e = OSError(2, "No such file")
    out = format_error(e)
    assert out["code"] == 2


def test_format_error_lifts_a_botocore_client_error_shape():
    # botocore buries the code in response["Error"]["Code"]; without this the
    # AccessDenied-vs-NoSuchEntity distinction is only a substring of prose.
    class ClientError(Exception):
        response = {
            "Error": {"Code": "AccessDenied", "Message": "nope"},
            "ResponseMetadata": {"HTTPStatusCode": 403},
        }

    out = format_error(ClientError("nope"))
    assert out["code"] == "AccessDenied"
    assert out["status"] == 403


def test_format_error_records_the_cause_recursively():
    try:
        try:
            try:
                raise OSError(2, "No such file")
            except OSError as root:
                raise ValueError("middle") from root
        except ValueError as inner:
            raise RuntimeError("outer") from inner
    except RuntimeError as e:
        out = format_error(e)
    assert out["cause"]["type"] == "ValueError"
    assert out["cause"]["message"] == "middle"
    assert out["cause"]["cause"]["code"] == 2


def test_format_error_survives_a_cyclic_cause_chain():
    a = ValueError("a")
    b = ValueError("b")
    a.__cause__ = b
    b.__cause__ = a
    out = format_error(a)  # must terminate rather than recurse forever
    assert out["type"] == "ValueError"


def test_format_error_survives_a_str_that_raises():
    class Nasty(Exception):
        def __str__(self):
            raise RuntimeError("nope")

    out = format_error(Nasty())
    assert out["type"] == "Nasty"
    assert out["message"]


# --- configure_logging ------------------------------------------------------


@pytest.mark.parametrize("service", ["webhooks", "broker"])
def test_configure_logging_installs_json_when_forced(monkeypatch, capsys, service):
    monkeypatch.setenv("LOG_FORMAT", "json")
    configure_logging(service, "INFO")
    logging.getLogger(f"{service}.store").info(
        "stored mapping", extra={"component": "store", "conversation_id": "c1"}
    )
    out = json.loads(capsys.readouterr().out.strip())
    assert out["msg"] == "stored mapping"
    assert out["component"] == "store"
    assert out["conversation_id"] == "c1"
    assert out["service"] == service


def test_configure_logging_honors_pretty(monkeypatch, capsys):
    monkeypatch.setenv("LOG_FORMAT", "pretty")
    configure_logging("webhooks", "INFO")
    logging.getLogger("webhooks.store").info(
        "stored mapping", extra={"component": "store", "conversation_id": "c1"}
    )
    line = capsys.readouterr().out.strip()
    assert "[store] stored mapping" in line
    assert "conversation_id=c1" in line


def test_json_is_the_default_in_a_container(monkeypatch, capsys):
    monkeypatch.delenv("LOG_FORMAT", raising=False)
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
    configure_logging("webhooks", "INFO")
    logging.getLogger("webhooks.store").info("x", extra={"component": "store"})
    json.loads(capsys.readouterr().out.strip())


def test_pretty_is_the_default_outside_a_container(monkeypatch, capsys):
    monkeypatch.delenv("LOG_FORMAT", raising=False)
    monkeypatch.delenv("KUBERNETES_SERVICE_HOST", raising=False)
    configure_logging("webhooks", "INFO")
    logging.getLogger("webhooks.store").info("x", extra={"component": "store"})
    assert "[store] x" in capsys.readouterr().out


def test_log_level_env_is_honored(monkeypatch, capsys):
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    configure_logging("webhooks")
    log = logging.getLogger("webhooks.store")
    log.info("dropped", extra={"component": "store"})
    log.warning("kept", extra={"component": "store"})
    lines = [x for x in capsys.readouterr().out.strip().splitlines() if x]
    assert len(lines) == 1
    assert json.loads(lines[0])["msg"] == "kept"


def test_an_explicit_level_beats_the_env(monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    monkeypatch.setenv("LOG_LEVEL", "WARNING")
    configure_logging("webhooks", "DEBUG")
    assert logging.getLogger().level == logging.DEBUG


def test_configure_logging_does_not_stack_handlers(monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    configure_logging("webhooks", "INFO")
    configure_logging("webhooks", "INFO")
    ours = [h for h in logging.getLogger().handlers if h.get_name() == HANDLER_NAME]
    assert len(ours) == 1


def test_configure_logging_leaves_a_foreign_handler_alone(monkeypatch):
    # pytest's caplog is a StreamHandler SUBCLASS; nuking every root handler
    # (what one of the copies this replaced did) silently kills test capture.
    class ForeignHandler(logging.StreamHandler):
        pass

    monkeypatch.setenv("LOG_FORMAT", "json")
    foreign = ForeignHandler()
    logging.getLogger().addHandler(foreign)
    configure_logging("webhooks", "INFO")
    assert foreign in logging.getLogger().handlers


def test_an_unknown_level_falls_back_to_info(monkeypatch):
    monkeypatch.setenv("LOG_FORMAT", "json")
    configure_logging("webhooks", "NONSENSE")
    assert logging.getLogger().level == logging.INFO


def test_pretty_formatter_renders_an_exception():
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        line = PrettyFormatter("webhooks").format(
            _record(level=logging.ERROR, exc_info=sys.exc_info(), extra={"component": "store"})
        )
    assert "[store]" in line
    assert "ValueError: boom" in line


# --- get_logger -------------------------------------------------------------


def test_get_logger_names_the_component_under_the_service():
    logger = get_logger("scheduler", "spawn")
    assert logger.name == "scheduler.spawn"
    assert _emit(_record(name=logger.name), service="scheduler")["component"] == "spawn"
