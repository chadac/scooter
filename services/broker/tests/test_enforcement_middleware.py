"""Core-enforced authz+audit pipeline around EVERY provider route (RED-FIRST —
see todo/docs/EXTENSIBLE_BROKER.md).

The guarantee: enforcement is core ASGI middleware, not a provider-called helper.
For any /<provider>/... request the core runs
  authenticate -> classify/authorize -> (audit decision) -> handler -> (audit result)
so a provider — including a 3rd-party one — physically cannot skip authz or audit.

Uses the built-in `test` (echo) provider as the mounted provider and overrides
`authenticate` with a fake identity (same pattern as test_whoami.py). The policy
+ audit sink are injected into create_app(); audit is asserted by capturing the
JSON-log stream the default JsonLogSink emits.
"""

from __future__ import annotations

import json
import logging
import os

os.environ["TEST_PROVIDER_ENABLED"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

from broker.core.app import create_app  # noqa: E402
from broker.core.auth import authenticate  # noqa: E402
from broker.core.types import Identity  # noqa: E402
from broker.core.policy import DeclarativePolicy  # noqa: E402
from broker.core.audit import JsonLogSink, AUDIT_LOGGER_NAME  # noqa: E402


def _fake_identity() -> Identity:
    return Identity(
        conversation_id="conv-abc123",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:sandbox-conv-abc123",
    )


def _client(policy, audit) -> TestClient:
    # create_app grows optional injection seams for the policy + audit sink so a
    # test (and a deployer) can supply them; default is the config-driven ones.
    app = create_app(policy=policy, audit=audit)
    app.dependency_overrides[authenticate] = _fake_identity
    return TestClient(app)


def _audit_payloads(caplog) -> list[dict]:
    return [
        json.loads(r.getMessage())
        for r in caplog.records
        if r.name == AUDIT_LOGGER_NAME
    ]


def test_allow_lets_the_request_through_and_audits_it(caplog):
    policy = DeclarativePolicy.from_config({"default": "allow"})
    client = _client(policy, JsonLogSink())

    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER_NAME):
        resp = client.get("/test/whoami")
    assert resp.status_code == 200

    events = _audit_payloads(caplog)
    assert len(events) == 1
    assert events[0]["provider"] == "test"
    assert events[0]["decision"] == "allow"


def test_deny_blocks_the_handler_and_still_audits(caplog):
    policy = DeclarativePolicy.from_config({"default": "deny"})
    client = _client(policy, JsonLogSink())

    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER_NAME):
        resp = client.get("/test/whoami")
    assert resp.status_code == 403

    # The denied call is still emitted — audit precedes the (skipped) handler.
    events = _audit_payloads(caplog)
    assert len(events) == 1
    assert events[0]["decision"] == "denied"


def test_every_provider_route_is_wrapped_no_optout(caplog):
    # A provider CANNOT expose a route outside enforcement: the git-credential
    # transport route on the same provider is audited too.
    policy = DeclarativePolicy.from_config({"default": "allow"})
    client = _client(policy, JsonLogSink())

    with caplog.at_level(logging.INFO, logger=AUDIT_LOGGER_NAME):
        client.get("/test/git-credentials")
    events = _audit_payloads(caplog)
    assert any(e["path"].endswith("git-credentials") for e in events), "route bypassed enforcement/audit"


def test_default_audit_sink_is_best_effort_not_fail_closed(caplog):
    # The shipped JsonLogSink is required=False: even if its emit blows up, the
    # request is NOT 503'd (a logging hiccup must not drop broker traffic). Only a
    # deployer-supplied `required` sink fail-closes (covered in test_audit.py).
    class BoomSink:
        required = False

        async def record(self, e) -> None:
            raise RuntimeError("sink down")

    policy = DeclarativePolicy.from_config({"default": "allow"})
    client = _client(policy, BoomSink())

    resp = client.get("/test/whoami")
    assert resp.status_code == 200  # not 503 — best-effort audit


def test_required_sink_fail_closes(caplog):
    # A sink marked required=True that can't record → the request is refused (503).
    class RequiredBoomSink:
        required = True

        async def record(self, e) -> None:
            raise RuntimeError("durable sink down")

    policy = DeclarativePolicy.from_config({"default": "allow"})
    client = _client(policy, RequiredBoomSink())

    resp = client.get("/test/whoami")
    assert resp.status_code == 503


def test_non_provider_routes_are_not_gated():
    # Core control routes (health, /link, sandbox) are not provider calls and must
    # not be forced through provider scope enforcement.
    policy = DeclarativePolicy.from_config({"default": "deny"})  # would 403 provider calls
    client = _client(policy, JsonLogSink())

    # A health/liveness endpoint still answers even under default-deny.
    resp = client.get("/health")
    assert resp.status_code in (200, 204)
