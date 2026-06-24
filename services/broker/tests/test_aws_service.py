"""Lifecycle tests for PermissionService — RED against the design boilerplate.

Drives the full request lifecycle against a FAKE IamProvisioner + an in-memory
store, so no AWS. Defines the contract the Implementation stage must satisfy:
request → approve → active+creds → refresh → revoke, plus deny, guardrail
rejection, cross-conversation isolation, and the expiry sweep.

These FAIL until service.py / store.py / iam.py are implemented (NotImplementedError).
"""

from __future__ import annotations

import pytest

from broker.aws.iam import IamProvisioner
from broker.aws.models import PermissionRequest, RequestStatus, StsCredentials
from broker.aws.service import PermissionService, ServiceConfig, RequestError
from broker.aws.store import PermissionStore


# --- fakes ----------------------------------------------------------------
class FakeIam(IamProvisioner):
    """In-memory IAM: records created roles/policies, mints fake creds."""

    def __init__(self):  # noqa: D401 — deliberately bypass the real __init__
        self.policies: dict[str, dict] = {}
        self.roles: dict[str, dict] = {}
        self._n = 0

    def create_dynamic_policy(self, *, target_account, request_id, policy_document):
        arn = f"arn:aws:iam::123:policy/agent-broker-{request_id}"
        self.policies[arn] = policy_document
        return arn

    def create_dynamic_role(self, *, target_account, request_id, policy_arn, managed_policy_arns, duration_seconds):
        self._n += 1
        arn = f"arn:aws:iam::123:role/agent-broker-{request_id}"
        self.roles[arn] = {"policy_arn": policy_arn, "managed": managed_policy_arns}
        return arn, StsCredentials("AKIA", "secret", f"tok{self._n}", "us-east-1", "2030-01-01T00:00:00Z")

    def assume_dynamic_role(self, *, target_account, role_arn, request_id, duration_seconds):
        self._n += 1
        return StsCredentials("AKIA", "secret", f"tok{self._n}", "us-east-1", "2030-01-01T00:00:00Z")

    def delete_dynamic_policy(self, *, target_account, policy_arn):
        self.policies.pop(policy_arn, None)
        return True

    def delete_dynamic_role(self, *, target_account, role_arn, policy_arn):
        self.roles.pop(role_arn, None)
        if policy_arn:
            self.policies.pop(policy_arn, None)
        return True


REGISTRY = {
    "dev": {"account_id": "123", "broker_role_arn": "arn:...:base", "enabled": True,
            "allowed_policy": {"Statement": [{"Action": ["s3:*"], "Resource": ["*"]}]}},
    "prod": {"account_id": "456", "broker_role_arn": "arn:...:base", "enabled": True,
             "allowed_policy": {"Statement": [{"Action": ["s3:Get*"], "Resource": ["*"]}]}},
    "off": {"account_id": "789", "broker_role_arn": "arn:...:base", "enabled": False},
}

READ = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*"}]}


def make_service(tmp_path):
    store = PermissionStore(str(tmp_path / "broker.db"))
    store.init()
    svc = PermissionService(
        store=store,
        iam=FakeIam(),
        account_registry=REGISTRY,
        config=ServiceConfig(broker_principal_arn="arn:...:broker"),
    )
    return svc


# --- request -------------------------------------------------------------
def test_request_creates_pending(tmp_path):
    svc = make_service(tmp_path)
    req = svc.request(conversation_id="c1", target_account="dev", justification="read a file", policy_document=READ)
    assert req.status == RequestStatus.PENDING
    assert req.request_id
    assert req.conversation_id == "c1"
    assert req.iam_policy_arn  # inline policy created eagerly


def test_request_rejects_blocked_action(tmp_path):
    svc = make_service(tmp_path)
    bad = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "iam:CreateRole", "Resource": "*"}]}
    with pytest.raises(RequestError):
        svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=bad)


def test_request_rejects_out_of_bounds(tmp_path):
    svc = make_service(tmp_path)
    # prod only allows s3:Get*; a PutObject is out of bounds.
    put = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::b/*"}]}
    with pytest.raises(RequestError):
        svc.request(conversation_id="c1", target_account="prod", justification="x", policy_document=put)


def test_request_rejects_disabled_account(tmp_path):
    svc = make_service(tmp_path)
    with pytest.raises(RequestError):
        svc.request(conversation_id="c1", target_account="off", justification="x", policy_document=READ)


# --- approve -> active + creds ------------------------------------------
def test_approve_provisions_and_activates(tmp_path):
    svc = make_service(tmp_path)
    req = svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    approved = svc.approve(request_id=req.request_id, approver="alice@x")
    assert approved.status == RequestStatus.ACTIVE
    assert approved.iam_role_arn
    assert approved.approved_by == "alice@x"
    assert approved.role_expires_at

    got, creds = svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.ACTIVE
    assert creds is not None and creds.session_token


def test_deny_marks_denied_and_removes_policy(tmp_path):
    svc = make_service(tmp_path)
    req = svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    denied = svc.deny(request_id=req.request_id, approver="alice@x", reason="nope")
    assert denied.status == RequestStatus.DENIED
    # No creds available on a denied request.
    _, creds = svc.status(request_id=req.request_id, conversation_id="c1")
    assert creds is None


# --- isolation -----------------------------------------------------------
def test_cross_conversation_isolation(tmp_path):
    svc = make_service(tmp_path)
    req = svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    svc.approve(request_id=req.request_id, approver="a")
    # Another conversation cannot read c1's request/creds.
    got, creds = svc.status(request_id=req.request_id, conversation_id="c2")
    assert got is None or creds is None


# --- refresh + revoke ----------------------------------------------------
def test_refresh_mints_new_creds(tmp_path):
    svc = make_service(tmp_path)
    req = svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    svc.approve(request_id=req.request_id, approver="a")
    _, c1 = svc.status(request_id=req.request_id, conversation_id="c1")
    _, c2 = svc.refresh(request_id=req.request_id, conversation_id="c1")
    assert c2.session_token and c2.session_token != c1.session_token


def test_revoke_tears_down(tmp_path):
    svc = make_service(tmp_path)
    req = svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    svc.approve(request_id=req.request_id, approver="a")
    revoked = svc.revoke(request_id=req.request_id, conversation_id="c1")
    assert revoked.status == RequestStatus.REVOKED
    _, creds = svc.status(request_id=req.request_id, conversation_id="c1")
    assert creds is None


# --- expiry sweep --------------------------------------------------------
def test_sweep_expires_past_ttl(tmp_path):
    svc = make_service(tmp_path)
    req = svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    svc.approve(request_id=req.request_id, approver="a")
    # Force the role TTL into the past, then sweep.
    svc._store.update(req.request_id, role_expires_at="2000-01-01T00:00:00Z")  # type: ignore[attr-defined]
    swept = svc.sweep_expired()
    assert req.request_id in swept
    got, creds = svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.EXPIRED
    assert creds is None
