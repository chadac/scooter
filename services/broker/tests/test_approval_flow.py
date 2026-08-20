"""Generic ASYNC approval flow for REQUIRE_APPROVAL (RED-FIRST — see
todo/docs/EXTENSIBLE_BROKER.md).

When authorization yields REQUIRE_APPROVAL, the middleware does NOT block the
request. It matches AWS's async shape (the unifying model):

  1. First call to a require-approval scope → 202 with {approval_id}; a pending
     approval record is created and the agent-host is notified (to raise the
     approval interrupt). The handler does NOT run.
  2. A human approves via POST /approval/{id}/approve (approver identity) →
     provider.on_approved runs; the record flips to approved.
  3. The caller RETRIES the original request → the middleware finds an approved
     record for this (conversation, scope) → the handler runs (200) + audited.
  4. A denied record → the retry is 403.

Pinned here against the built-in `test` (echo) provider with an injected policy
that require-approvals its scope. AWS being re-expressed on this same flow is
covered by the AWS tests once ported.
"""

from __future__ import annotations

import os

os.environ["TEST_PROVIDER_ENABLED"] = "true"

from fastapi.testclient import TestClient  # noqa: E402

from broker.core.app import create_app  # noqa: E402
from broker.core.auth import authenticate  # noqa: E402
from broker.core.types import Identity  # noqa: E402
from broker.core.policy import DeclarativePolicy  # noqa: E402
from broker.core.audit import JsonLogSink  # noqa: E402
from broker.core.approval import InMemoryApprovalStore  # noqa: E402


def _identity() -> Identity:
    return Identity(
        conversation_id="conv-abc123",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:sandbox-conv-abc123",
    )


def _approver() -> Identity:
    # A non-sandbox approver SA (the agent-host relaying the user's approve).
    return Identity(
        conversation_id="",
        namespace="agent-sandbox",
        service_account="system:serviceaccount:agent-sandbox:agent-host",
        is_approver=True,
    )


def _client(approvals, notified=None):
    # The test provider's default scope is "test:api:<action>"; require-approve it.
    policy = DeclarativePolicy.from_config(
        {"default": "allow", "rules": [{"scope": "test:*:*", "decision": "require-approval"}]}
    )
    app = create_app(policy=policy, audit=JsonLogSink(), approvals=approvals, on_approval_request=notified)
    app.dependency_overrides[authenticate] = _identity
    return app


def test_require_approval_returns_202_and_creates_a_pending_record():
    approvals = InMemoryApprovalStore()
    seen = []
    app = _client(approvals, notified=lambda rec: seen.append(rec))
    client = TestClient(app)

    resp = client.get("/test/whoami")
    assert resp.status_code == 202
    body = resp.json()
    assert "approval_id" in body
    # A pending record exists for THIS conversation + scope, and the host was
    # notified (so it can raise the approval interrupt).
    rec = approvals.get(body["approval_id"])
    assert rec is not None and rec.status == "pending"
    assert rec.conversation_id == "conv-abc123"
    assert len(seen) == 1


def test_retry_after_approve_runs_the_handler():
    approvals = InMemoryApprovalStore()
    app = _client(approvals)

    # We need the approver identity for the approve call, the sandbox identity for
    # the rest. Two clients, same app + store.
    from broker.core.auth import authenticate as _auth

    caller = TestClient(app)
    resp = caller.get("/test/whoami")
    approval_id = resp.json()["approval_id"]

    # Approve as the approver.
    app.dependency_overrides[_auth] = _approver
    ok = caller.post(f"/approval/{approval_id}/approve")
    assert ok.status_code == 200
    assert approvals.get(approval_id).status == "approved"

    # Back to the sandbox caller — the retry now runs (an approved record for this
    # conversation+scope satisfies the gate).
    app.dependency_overrides[_auth] = _identity
    retry = caller.get("/test/whoami")
    assert retry.status_code == 200


def test_denied_retry_is_403():
    approvals = InMemoryApprovalStore()
    app = _client(approvals)
    caller = TestClient(app)

    approval_id = caller.get("/test/whoami").json()["approval_id"]

    from broker.core.auth import authenticate as _auth

    app.dependency_overrides[_auth] = _approver
    caller.post(f"/approval/{approval_id}/deny", json={"reason": "nope"})
    assert approvals.get(approval_id).status == "denied"

    app.dependency_overrides[_auth] = _identity
    retry = caller.get("/test/whoami")
    assert retry.status_code == 403


def test_on_approved_side_effect_runs_on_approve():
    # A provider's on_approved must run exactly once, on approve (email: none; AWS:
    # mint STS). Simulated via a provider-agnostic callback the store invokes.
    approvals = InMemoryApprovalStore()
    ran: list[str] = []
    approvals.set_on_approved(lambda rec: ran.append(rec.id))

    app = _client(approvals)
    caller = TestClient(app)
    approval_id = caller.get("/test/whoami").json()["approval_id"]

    from broker.core.auth import authenticate as _auth

    app.dependency_overrides[_auth] = _approver
    caller.post(f"/approval/{approval_id}/approve")
    assert ran == [approval_id]  # once, on approve
