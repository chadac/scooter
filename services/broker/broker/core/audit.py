"""Audit — a structured-log event STREAM (not a SQL table).

Every broker call emits an AuditEvent. The primary consumer is observability (a
Datadog dashboard over broker calls), so the shipped default sink (JsonLogSink)
writes ONE JSON line per event to a dedicated logger -> stdout -> Datadog's log
pipeline facets the core attributes for free; the extensible `attributes` bag
becomes custom facets. The event carries metadata only — NEVER the credential or
the request/response body.

Failure posture is PER-SINK via a `required` flag. The shipped JsonLogSink is
best-effort (`required=False`): a logging hiccup must not 503 a request; the
middleware wraps a non-required sink with `emit_best_effort` so its errors can't
break the call. A deployer who plugs in a durable/queryable sink can set
`required=True` to get fail-closed there. The durable "no un-recorded approval"
guarantee is a different concern — it lives in the approval flow's own store.

See todo/docs/EXTENSIBLE_BROKER.md.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable

# A DEDICATED logger so the audit line is self-contained JSON regardless of the
# app's root formatter (Datadog parses the message body as JSON).
AUDIT_LOGGER_NAME = "broker.audit"
_audit_logger = logging.getLogger(AUDIT_LOGGER_NAME)


@dataclass
class AuditEvent:
    """One audited broker call. CORE attributes are always present (the dashboard
    axes); `attributes` is the open, provider/deployer-extensible bag. There is
    deliberately NO field that could hold a credential or a raw body."""

    conversation_id: str
    provider: str
    action: str  # "call" | "approve" | "deny"  (lifecycle verb)
    scope: str
    decision: str  # allow | approved | denied | error
    method: str
    path: str
    upstream_status: int | None = None
    approver: str | None = None
    # The open bag: a provider's AuthzResult.detail rides here (recipients, policy
    # ARNs) -> custom facets, without changing the core schema. NEVER secrets.
    attributes: dict = field(default_factory=dict)

    def to_payload(self) -> dict:
        """Flatten to a single JSON object: core attrs + the attributes bag
        promoted to top-level keys (so they're first-class Datadog facets). Core
        keys win on a name clash."""
        payload = dict(self.attributes or {})
        payload.update(
            {
                "conversation_id": self.conversation_id,
                "provider": self.provider,
                "action": self.action,
                "scope": self.scope,
                "decision": self.decision,
                "method": self.method,
                "path": self.path,
                "upstream_status": self.upstream_status,
                "approver": self.approver,
            }
        )
        return payload


@runtime_checkable
class AuditSink(Protocol):
    """A destination for AuditEvents. `required=True` -> fail-closed (an emit
    failure 503s the call, via the middleware); `required=False` -> best-effort."""

    required: bool

    async def record(self, e: AuditEvent) -> None: ...


class JsonLogSink:
    """The shipped default: one JSON line per event to AUDIT_LOGGER_NAME. Best-
    effort (a logging blip must not drop broker traffic)."""

    required: bool = False

    async def record(self, e: AuditEvent) -> None:
        _audit_logger.info(json.dumps(e.to_payload()))


class AuditWriteError(RuntimeError):
    """Raised by a durable sink when it cannot record. On a `required` sink this
    propagates and the middleware turns it into a 503 (fail-closed)."""


async def emit_best_effort(sink: AuditSink, event: AuditEvent) -> None:
    """Record via a NON-required sink, swallowing (logging) any emit error so it
    can't break the request. The middleware calls this for `required=False` sinks
    and calls `sink.record` directly (letting errors propagate to a 503) for
    `required=True` sinks."""
    try:
        await sink.record(event)
    except Exception as exc:  # noqa: BLE001 — a best-effort sink must never break the call
        _audit_logger.warning("audit sink emit failed (best-effort, dropped): %s", exc)
