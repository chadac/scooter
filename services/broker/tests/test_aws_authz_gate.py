"""The per-account OpenFGA gate on approve/deny, inside PermissionService.

The broker ENFORCES that the approving user may approve the request's TARGET
ACCOUNT (relation `approver` on `aws_account:<acct>`), via an injected Authorizer.
A NoopAuthorizer (FGA off) allows everything, preserving today's behavior. We use
a FAKE authorizer here (no live OpenFGA).
"""

from __future__ import annotations

import pytest

from broker.aws.iam import IamProvisioner
from broker.aws.models import RequestStatus, StsCredentials
from broker.aws.service import PermissionService, ServiceConfig, RequestError
from broker.aws.store import PermissionStore, StoreConfig
from broker.core.authz import NoopAuthorizer


class FakeIam(IamProvisioner):
    def __init__(self):
        self._n = 0

    def create_dynamic_policy(self, *, target_account, request_id, policy_document):
        return f"arn:aws:iam::123:policy/{request_id}"

    def create_dynamic_role(self, *, target_account, request_id, policy_arn, managed_policy_arns, duration_seconds):
        self._n += 1
        return f"arn:aws:iam::123:role/{request_id}", StsCredentials("AKIA", "s", f"t{self._n}", "us-east-1", "2030-01-01T00:00:00Z")

    def assume_dynamic_role(self, *, target_account, role_arn, request_id, duration_seconds):
        return StsCredentials("AKIA", "s", "t", "us-east-1", "2030-01-01T00:00:00Z")

    def delete_dynamic_policy(self, *, target_account, policy_arn):
        return True

    def delete_dynamic_role(self, *, target_account, role_arn, policy_arn):
        return True


REGISTRY = {
    "dev": {"account_id": "123", "broker_role_arn": "arn:base", "enabled": True,
            "allowed_policy": {"Statement": [{"Action": ["s3:*"], "Resource": ["*"]}]}},
}
READ = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*"}]}


class FakeAuthorizer:
    """Allows only specific (user, relation, obj) tuples."""

    def __init__(self, allowed: set[tuple[str, str, str]]):
        self.allowed = allowed
        self.granted: list[tuple[str, str, str]] = []

    async def check(self, *, user: str, relation: str, obj: str) -> bool:
        return (user, relation, obj) in self.allowed

    async def grant(self, *, user: str, relation: str, obj: str) -> None:
        self.granted.append((user, relation, obj))


async def _service(tmp_path, authorizer):
    cfg = StoreConfig()
    cfg.dsn = f"sqlite+aiosqlite:///{tmp_path / 'b.db'}"
    store = PermissionStore(cfg)
    await store.init()
    return PermissionService(
        store=store, iam=FakeIam(), account_registry=REGISTRY,
        config=ServiceConfig(broker_principal_arn="arn:broker"),
        authorizer=authorizer,
    )


async def _pending(svc):
    return await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)


async def test_approve_allowed_when_user_is_account_approver(tmp_path):
    authz = FakeAuthorizer({("user:alice", "approver", "aws_account:dev")})
    svc = await _service(tmp_path, authz)
    req = await _pending(svc)
    out = await svc.approve(request_id=req.request_id, approver="user:alice")
    assert out.status == RequestStatus.ACTIVE
    assert out.approved_by == "user:alice"


async def test_approve_denied_when_user_not_approver_for_account(tmp_path):
    # alice may approve "prod" but NOT "dev" — and this request targets dev.
    authz = FakeAuthorizer({("user:alice", "approver", "aws_account:prod")})
    svc = await _service(tmp_path, authz)
    req = await _pending(svc)
    with pytest.raises(RequestError):
        await svc.approve(request_id=req.request_id, approver="user:alice")
    # The request stays PENDING (not approved) on an authz failure.
    again = await svc._store.get(req.request_id)
    assert again.status == RequestStatus.PENDING


async def test_deny_also_gated_on_account_approver(tmp_path):
    authz = FakeAuthorizer(set())  # nobody is an approver
    svc = await _service(tmp_path, authz)
    req = await _pending(svc)
    with pytest.raises(RequestError):
        await svc.deny(request_id=req.request_id, approver="user:bob", reason="no")


async def test_noop_authorizer_allows_approve(tmp_path):
    # FGA off -> NoopAuthorizer -> approve works regardless of tuples (today's behavior).
    svc = await _service(tmp_path, NoopAuthorizer())
    req = await _pending(svc)
    out = await svc.approve(request_id=req.request_id, approver="anyone")
    assert out.status == RequestStatus.ACTIVE
