"""Audit: a structured-log event STREAM (RED-FIRST — see
todo/docs/EXTENSIBLE_BROKER.md).

Every broker call emits an AuditEvent. The shipped default is a JSON-LOG sink
(one JSON line per event → stdout → Datadog's log pipeline facets it), NOT a SQL
table: a few fixed CORE attributes (the dashboard axes) plus an extensible
`attributes` bag (provider/deployer enrichment). The event carries metadata only
— NEVER the credential or the request/response body.

Failure posture is PER-SINK via a `required` flag: the shipped JsonLogSink is
best-effort (required=False → a stdout hiccup never 503s a request). A deployer
who plugs in a durable sink can mark it required to get fail-closed there. (The
durable "no un-recorded approval" guarantee lives in the approval flow's own
PermissionStore, not here.)
"""

from __future__ import annotations

import json
import logging

from broker.core.audit import AuditEvent, JsonLogSink, AUDIT_LOGGER_NAME


def _event(**over) -> AuditEvent:
    base = dict(
        conversation_id="conv-1",
        provider="github",
        action="call",
        scope="github:repo:write",
        decision="allow",
        method="POST",
        path="/repos/o/r/issues",
        upstream_status=201,
        approver=None,
    )
    base.update(over)
    return AuditEvent(**base)


async def test_jsonlog_sink_emits_one_json_line_with_core_attrs(caplog):
    sink = JsonLogSink()
    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER_NAME):
        await sink.record(_event())

    recs = [r for r in caplog.records if r.name == AUDIT_LOGGER_NAME]
    assert len(recs) == 1
    payload = json.loads(recs[0].getMessage())  # the whole message is valid JSON
    for k in ("conversation_id", "provider", "action", "scope", "decision", "method", "path"):
        assert k in payload
    assert payload["scope"] == "github:repo:write"
    assert payload["decision"] == "allow"


async def test_extensible_attributes_bag_is_flattened_into_the_event(caplog):
    # A provider's AuthzResult.detail rides here (email recipients, aws policy arns)
    # → custom Datadog facets, without changing the core schema.
    sink = JsonLogSink()
    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER_NAME):
        await sink.record(_event(attributes={"recipients": "a@x.com,b@y.com", "count": 2}))
    payload = json.loads([r for r in caplog.records if r.name == AUDIT_LOGGER_NAME][0].getMessage())
    assert payload["recipients"] == "a@x.com,b@y.com"
    assert payload["count"] == 2


def test_audit_event_never_carries_secrets_or_body():
    # Structural guarantee: no field could hold a credential or a raw body.
    fields = set(AuditEvent.__dataclass_fields__)
    for forbidden in ("credential", "token", "secret", "body", "request_body", "response_body"):
        assert forbidden not in fields, f"AuditEvent must not carry {forbidden}"


def test_jsonlog_sink_is_best_effort_not_required():
    # The shipped default must NOT be fail-closed (a logging blip shouldn't 503).
    assert JsonLogSink().required is False


async def test_sink_emit_failure_on_a_nonrequired_sink_does_not_raise(caplog):
    # A best-effort sink swallows its own emit error (logs it) rather than
    # propagating — the middleware only fail-closes on a `required` sink.
    class BoomSink:
        required = False

        async def record(self, e: AuditEvent) -> None:
            raise RuntimeError("sink down")

    # The core's emit helper wraps a non-required sink so it can't break the call.
    from broker.core.audit import emit_best_effort

    await emit_best_effort(BoomSink(), _event())  # must not raise
