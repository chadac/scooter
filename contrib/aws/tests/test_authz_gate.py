"""The per-account authorizer gate on approve/deny inside PermissionService, against a fake Authorizer."""

from __future__ import annotations

import pytest

from scooter_contrib_aws.iam import IamProvisioner
from scooter_contrib_aws.models import RequestStatus, StsCredentials, approval_message
from scooter_contrib_aws.service import ApprovalCheck, PermissionService, ServiceConfig, RequestError
from scooter_contrib_aws.store import PermissionStore
from scooter_broker_lib.store import StoreConfig
from scooter_broker_lib.authz import NoopAuthorizer

from scooter_broker_lib.testing import create_schema
from scooter_contrib_aws import store as aws_store


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


from rule_sets import compiled

REGISTRY = {
    "dev": {"account_id": "123", "broker_role_arn": "arn:base", "enabled": True,
            "allowed_policy": {"Statement": [{"Action": ["s3:*"], "Resource": ["*"]}]},
            "approval_rules": compiled()},
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
    await create_schema(store, aws_store._Base)
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
    out = await svc.approve(request_id=req.request_id, approver="alice")
    assert out.status == RequestStatus.ACTIVE
    assert out.approved_by == "alice"


async def test_approve_denied_when_user_not_approver_for_account(tmp_path):
    authz = FakeAuthorizer({("user:alice", "approver", "aws_account:prod")})
    svc = await _service(tmp_path, authz)
    req = await _pending(svc)
    with pytest.raises(RequestError):
        await svc.approve(request_id=req.request_id, approver="alice")
    again = await svc._store.get(req.request_id)
    assert again.status == RequestStatus.PENDING


async def test_deny_also_gated_on_account_approver(tmp_path):
    authz = FakeAuthorizer(set())
    svc = await _service(tmp_path, authz)
    req = await _pending(svc)
    with pytest.raises(RequestError):
        await svc.deny(request_id=req.request_id, approver="bob", reason="no")


async def test_noop_authorizer_allows_approve(tmp_path):
    svc = await _service(tmp_path, NoopAuthorizer())
    req = await _pending(svc)
    out = await svc.approve(request_id=req.request_id, approver="anyone")
    assert out.status == RequestStatus.ACTIVE


# --- can_approve: read-only, per viewer ---

async def test_can_approve_true_for_account_approver(tmp_path):
    authz = FakeAuthorizer({("user:alice", "approver", "aws_account:dev")})
    svc = await _service(tmp_path, authz)
    req = await _pending(svc)
    assert await svc.can_approve(request_id=req.request_id, approver="alice") == ApprovalCheck(True, None, "pending")
    assert (await svc._store.get(req.request_id)).status == RequestStatus.PENDING


async def test_can_approve_false_when_not_approver_for_account(tmp_path):
    authz = FakeAuthorizer({("user:alice", "approver", "aws_account:prod")})
    svc = await _service(tmp_path, authz)
    req = await _pending(svc)
    assert await svc.can_approve(request_id=req.request_id, approver="alice") == ApprovalCheck(False, "not_eligible", "pending")


async def test_can_approve_false_for_unknown_request(tmp_path):
    svc = await _service(tmp_path, FakeAuthorizer(set()))
    assert await svc.can_approve(request_id="nope", approver="alice") == ApprovalCheck(False, "not_pending")


async def test_can_approve_false_when_authz_unreachable(tmp_path):
    class BoomAuthorizer(FakeAuthorizer):
        async def check(self, *, user, relation, obj):
            raise RuntimeError("FGA down")

    svc = await _service(tmp_path, BoomAuthorizer(set()))
    req = await _pending(svc)
    assert await svc.can_approve(request_id=req.request_id, approver="alice") == ApprovalCheck(False, "error", "pending")


async def test_can_approve_true_with_noop_authorizer(tmp_path):
    svc = await _service(tmp_path, NoopAuthorizer())
    req = await _pending(svc)
    assert (await svc.can_approve(request_id=req.request_id, approver="anyone")).can_approve is True


# --- check-time / seed-time prefix alignment -----------
# The seeder grants `user:<id>` while resolve_approver() hands approve() a bare claim, so the check must re-wrap it.


async def test_check_wraps_the_bare_approver_to_match_the_seeded_user_tuple(tmp_path):
    class RecordingAuthorizer(FakeAuthorizer):
        def __init__(self):
            super().__init__({("user:alice", "approver", "aws_account:dev")})
            self.checked: list[str] = []

        async def check(self, *, user, relation, obj):
            self.checked.append(user)
            return await super().check(user=user, relation=relation, obj=obj)

    authz = RecordingAuthorizer()
    svc = await _service(tmp_path, authz)
    req = await _pending(svc)
    out = await svc.approve(request_id=req.request_id, approver="alice")
    assert out.status == RequestStatus.ACTIVE
    assert authz.checked == ["user:alice"]


async def test_dict_approver_resolves_to_the_email_claim_then_matches(tmp_path):
    # The agent-host sends a full identity dict, from which resolve_approver() picks the email claim.
    authz = FakeAuthorizer({("user:alice@x", "approver", "aws_account:dev")})
    svc = await _service(tmp_path, authz)
    req = await _pending(svc)
    resolved = svc.resolve_approver(
        {"id": "u-1", "email": "alice@x", "name": "Alice"}, fallback="c1"
    )
    assert resolved == "alice@x"
    out = await svc.approve(request_id=req.request_id, approver=resolved)
    assert out.status == RequestStatus.ACTIVE


# --- obligations: several approver groups ----------------------------------
from rule_sets import rule  # noqa: E402

SECRETS = {"Version": "2012-10-17", "Statement": [
    {"Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": "prod/db"},
    {"Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::b/*"},
]}
MULTI = {
    "multi": {"account_id": "1", "broker_role_arn": "arn:base", "enabled": True,
              "approval_rules": compiled(before=[
                  rule("account/secrets", "require_always", ["secretsmanager:GetSecretValue"], approvers=["sec"]),
              ])},
}
SEC = ("user:sec", "approver", "aws_account:multi/account/secrets")
OPS = ("user:ops", "approver", "aws_account:multi")


async def _multi(tmp_path, allowed):
    svc = await _service(tmp_path, FakeAuthorizer(allowed))
    svc._registry = MULTI
    notified = []

    async def on_request(req):
        notified.append(req)

    svc._on_request = on_request
    req = await svc.request(conversation_id="c1", target_account="multi", justification="x", policy_document=SECRETS)
    return svc, req, notified


async def test_a_request_needing_two_groups_stays_pending_after_one(tmp_path):
    svc, req, notified = await _multi(tmp_path, {SEC, OPS})
    assert [o["rules"] for o in req.approval_obligations] == [["account/secrets"], ["account default"]]

    out = await svc.approve(request_id=req.request_id, approver="ops")
    assert out.status == RequestStatus.PENDING
    assert len(notified) == 2, "the interrupt is raised again for the remaining approver"
    assert "Still needs approval for: account/secrets" in approval_message(out)
    assert await svc.can_approve(request_id=req.request_id, approver="ops") == ApprovalCheck(False, "already_approved", "pending")
    assert (await svc.can_approve(request_id=req.request_id, approver="sec")).can_approve is True

    out = await svc.approve(request_id=req.request_id, approver="sec")
    assert out.status == RequestStatus.ACTIVE
    assert out.approved_by == "ops, sec"


async def test_require_always_cant_be_satisfied_by_another_rules_approver(tmp_path):
    svc, req, _ = await _multi(tmp_path, {OPS})
    await svc.approve(request_id=req.request_id, approver="ops")
    with pytest.raises(RequestError):
        await svc.approve(request_id=req.request_id, approver="ops")
    assert (await svc._store.get(req.request_id)).status == RequestStatus.PENDING


async def test_an_ineligible_approver_is_refused(tmp_path):
    svc, req, _ = await _multi(tmp_path, {SEC, OPS})
    with pytest.raises(RequestError):
        await svc.approve(request_id=req.request_id, approver="mallory")
    assert await svc.can_approve(request_id=req.request_id, approver="mallory") == ApprovalCheck(False, "not_eligible", "pending")


async def test_anyone_eligible_for_any_obligation_can_deny(tmp_path):
    svc, req, _ = await _multi(tmp_path, {SEC})
    out = await svc.deny(request_id=req.request_id, approver="sec", reason="no")
    assert out.status == RequestStatus.DENIED


async def test_a_request_from_before_obligations_needs_one_account_approval(tmp_path):
    svc = await _service(tmp_path, FakeAuthorizer({("user:alice", "approver", "aws_account:dev")}))
    req = await _pending(svc)
    await svc._store.update(req.request_id, approval_obligations=None)
    out = await svc.approve(request_id=req.request_id, approver="alice")
    assert out.status == RequestStatus.ACTIVE


async def test_a_registry_without_approval_rules_is_refused(tmp_path):
    svc = await _service(tmp_path, NoopAuthorizer())
    svc._registry = {"raw": {"enabled": True}}
    with pytest.raises(RequestError, match="approval_rules"):
        await svc.request(conversation_id="c1", target_account="raw", justification="x", policy_document=READ)


async def test_deny_rejects_the_request_even_after_an_earlier_allow(tmp_path):
    svc = await _service(tmp_path, NoopAuthorizer())
    svc._registry = {"d": {"enabled": True, "approval_rules": [
        rule("a", "allow", ["kms:*"]), rule("blocked/kms", "deny", ["kms:Delete*"]),
    ]}}
    doc = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "kms:*", "Resource": "*"}]}
    with pytest.raises(RequestError, match="blocked/kms"):
        await svc.request(conversation_id="c1", target_account="d", justification="x", policy_document=doc)
