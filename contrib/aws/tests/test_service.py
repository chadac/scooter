"""Lifecycle tests for PermissionService against a fake IamProvisioner and a SQLite store.

Covers request, approve, active creds, refresh, revoke, deny, guardrail rejection,
cross-conversation isolation, superseding and the expiry sweep.
"""

from __future__ import annotations

import pytest

from scooter_contrib_aws.iam import IamProvisioner
from scooter_contrib_aws.models import RequestStatus, StsCredentials
from scooter_contrib_aws.service import NotPending, PermissionService, ServiceConfig, RequestError
from scooter_contrib_aws.store import PermissionStore
from scooter_broker_lib.store import StoreConfig

from scooter_broker_lib.testing import create_schema
from scooter_contrib_aws import store as aws_store

from rule_sets import compiled, rule


# --- fakes ----------------------------------------------------------------
class FakeIam(IamProvisioner):
    """In-memory IAM that records created roles and policies and mints fake creds."""

    def __init__(self):  # noqa: D401 — bypasses the real __init__
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
            "allowed_policy": {"Statement": [{"Action": ["s3:*"], "Resource": ["*"]}]},
            "approval_rules": compiled()},
    "prod": {"account_id": "456", "broker_role_arn": "arn:...:base", "enabled": True,
             "allowed_policy": {"Statement": [{"Action": ["s3:Get*"], "Resource": ["*"]}]},
             "approval_rules": compiled()},
    "off": {"account_id": "789", "broker_role_arn": "arn:...:base", "enabled": False},
    # Uses the read-only rule set.
    "ro": {"account_id": "999", "broker_role_arn": "arn:...:base", "enabled": True,
           "auto_approve_read_only": True, "description": "read-only sandbox",
           "allowed_policy": {"Statement": [{"Action": ["*"], "Resource": ["*"]}]},
           "approval_rules": compiled(read_only=True)},
    # Allow rule narrower than the ceiling.
    "auto": {"account_id": "111", "broker_role_arn": "arn:...:base", "enabled": True,
             "description": "auto-assume deploy roles",
             "allowed_policy": {"Statement": [{"Action": ["sts:*", "s3:*"], "Resource": ["*"]}]},
             "approval_rules": compiled(after=[rule("account/deploy-roles", "allow", ["sts:AssumeRole"],
                                                    ["arn:aws:iam::111:role/deploy-*"])])},
    # No approval_rules: a registry not rendered by the Nix module.
    "raw": {"account_id": "222", "broker_role_arn": "arn:...:base", "enabled": True},
}

ASSUME_OK = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
    "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::111:role/deploy-prod"}]}
# In the ceiling (sts:*) but not in the auto tier.
ASSUME_ADMIN = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow",
    "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::111:role/admin"}]}

WRITE = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::b/*"}]}

READ = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*"}]}


async def make_service(tmp_path, iam=None, on_withdraw=None):
    cfg = StoreConfig()
    cfg.dsn = f"sqlite+aiosqlite:///{tmp_path / 'broker.db'}"
    store = PermissionStore(cfg)
    await create_schema(store, aws_store._Base)
    svc = PermissionService(
        store=store,
        iam=iam or FakeIam(),
        account_registry=REGISTRY,
        config=ServiceConfig(broker_principal_arn="arn:...:broker"),
        on_withdraw=on_withdraw,
    )
    return svc


class FailingTeardownIam(FakeIam):
    """FakeIam whose teardown always fails, as the real helper does on a non-NoSuchEntity AWS error."""

    def delete_dynamic_policy(self, *, target_account, policy_arn):
        return False

    def delete_dynamic_role(self, *, target_account, role_arn, policy_arn):
        return False


class _FakeClientError(Exception):
    """Mimics botocore.exceptions.ClientError enough for _aws_error_reasons."""

    def __init__(self):
        super().__init__("An error occurred (AccessDenied) when calling AssumeRole")
        self.operation_name = "AssumeRole"
        self.response = {
            "Error": {"Code": "AccessDenied", "Message": "not authorized to perform sts:AssumeRole"},
            "ResponseMetadata": {"HTTPStatusCode": 403, "RequestId": "req-123"},
        }


class PolicyFailingIam(FakeIam):
    """create_dynamic_policy raises a boto-like ClientError, as when the account's broker IAM is not set up."""

    def create_dynamic_policy(self, *, target_account, request_id, policy_document):
        raise _FakeClientError()


# --- request -------------------------------------------------------------
async def test_request_creates_pending(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="read a file", policy_document=READ)
    assert req.status == RequestStatus.PENDING
    assert req.request_id
    assert req.conversation_id == "c1"
    # IAM provisioning is deferred to approval, so no policy ARN yet.
    assert req.iam_policy_arn is None


async def test_readonly_request_auto_approves_with_the_read_only_set(tmp_path):
    from scooter_contrib_aws.service import AUTO_APPROVE_PRINCIPAL

    notified = []
    svc = await make_service(tmp_path)
    svc._on_request = lambda req: notified.append(req)  # type: ignore[assignment]

    req = await svc.request(conversation_id="c1", target_account="ro", justification="read", policy_document=READ)
    assert req.status == RequestStatus.ACTIVE
    assert req.approved_by == AUTO_APPROVE_PRINCIPAL
    assert req.iam_role_arn
    got_req, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got_req is not None and creds is not None
    assert notified == []


async def test_allow_rule_auto_approves_covered_request(tmp_path):
    from scooter_contrib_aws.service import AUTO_APPROVE_PRINCIPAL

    notified = []
    svc = await make_service(tmp_path)
    svc._on_request = lambda req: notified.append(req)  # type: ignore[assignment]

    req = await svc.request(conversation_id="c1", target_account="auto",
                            justification="deploy", policy_document=ASSUME_OK)
    assert req.status == RequestStatus.ACTIVE
    assert req.approved_by == AUTO_APPROVE_PRINCIPAL
    assert notified == []


async def test_in_ceiling_but_not_auto_still_needs_human(tmp_path):
    notified = []
    svc = await make_service(tmp_path)
    svc._on_request = lambda req: notified.append(req)  # type: ignore[assignment]

    req = await svc.request(conversation_id="c1", target_account="auto",
                            justification="admin", policy_document=ASSUME_ADMIN)
    assert req.status == RequestStatus.PENDING
    assert len(notified) == 1


class ExpiringIam(FakeIam):
    """Mints an already-expired token on create and a fresh far-future token on refresh."""

    def create_dynamic_role(self, *, target_account, request_id, policy_arn, managed_policy_arns, duration_seconds):
        self._n += 1
        arn = f"arn:aws:iam::123:role/agent-broker-{request_id}"
        self.roles[arn] = {"policy_arn": policy_arn, "managed": managed_policy_arns}
        return arn, StsCredentials("AKIA", "secret", "STALE", "us-east-1", "2000-01-01T00:00:00Z")

    def assume_dynamic_role(self, *, target_account, role_arn, request_id, duration_seconds):
        self._n += 1
        return StsCredentials("AKIA", "secret", "FRESH", "us-east-1", "2030-01-01T00:00:00Z")


async def test_status_auto_refreshes_an_expired_cached_token(tmp_path):
    # The STS token expires while the role is still valid, so status() must re-vend from the role.
    svc = await make_service(tmp_path, iam=ExpiringIam())
    req = await svc.request(conversation_id="c1", target_account="ro", justification="read", policy_document=READ)
    assert req.status == RequestStatus.ACTIVE

    got_req, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got_req is not None and creds is not None
    assert creds.session_token == "FRESH", "status() must auto-refresh the stale token"
    assert creds.expires_at == "2030-01-01T00:00:00Z"


async def test_status_returns_no_creds_when_role_TTL_has_passed(tmp_path):
    svc = await make_service(tmp_path, iam=ExpiringIam())
    req = await svc.request(conversation_id="c1", target_account="ro", justification="read", policy_document=READ)
    await svc._store.update(req.request_id, role_expires_at="2000-01-01T00:00:00Z")

    got_req, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got_req is not None
    assert creds is None, "role TTL gone -> no creds; the agent must request again"


async def test_write_request_on_autoapprove_account_still_needs_a_human(tmp_path):
    notified = []
    svc = await make_service(tmp_path)
    svc._on_request = lambda req: notified.append(req)  # type: ignore[assignment]

    req = await svc.request(conversation_id="c1", target_account="ro", justification="write", policy_document=WRITE)
    assert req.status == RequestStatus.PENDING
    assert len(notified) == 1


async def test_readonly_request_without_optin_stays_pending(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    assert req.status == RequestStatus.PENDING


async def test_request_appears_pending_even_when_iam_is_unprovisioned(tmp_path):
    notified = []
    svc = await make_service(tmp_path, iam=PolicyFailingIam())
    svc._on_request = lambda req: notified.append(req)  # type: ignore[assignment]
    req = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    assert req.status == RequestStatus.PENDING
    assert req.iam_policy_arn is None
    assert len(notified) == 1


async def test_iam_provisioning_failure_at_APPROVE_is_a_verbose_error(tmp_path):
    svc = await make_service(tmp_path, iam=PolicyFailingIam())
    req = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    with pytest.raises(RequestError) as ei:
        await svc.approve(request_id=req.request_id, approver="admin@x.io")
    blob = " | ".join(ei.value.reasons)
    assert "AccessDenied" in blob
    assert "sts:AssumeRole" in blob
    assert "AssumeRole" in blob
    assert "403" in blob and "req-123" in blob
    assert "isn't set up yet" in blob
    got = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got[0] is not None and got[0].status == RequestStatus.ERROR


async def test_request_rejects_blocked_action(tmp_path):
    svc = await make_service(tmp_path)
    bad = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "iam:CreateRole", "Resource": "*"}]}
    with pytest.raises(RequestError):
        await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=bad)


async def test_request_rejects_out_of_bounds(tmp_path):
    svc = await make_service(tmp_path)
    put = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::b/*"}]}
    with pytest.raises(RequestError):
        await svc.request(conversation_id="c1", target_account="prod", justification="x", policy_document=put)


async def test_request_rejects_disabled_account(tmp_path):
    svc = await make_service(tmp_path)
    with pytest.raises(RequestError):
        await svc.request(conversation_id="c1", target_account="off", justification="x", policy_document=READ)


# --- approve -> active + creds ------------------------------------------
async def test_approve_provisions_and_activates(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    approved = await svc.approve(request_id=req.request_id, approver="alice@x")
    assert approved.status == RequestStatus.ACTIVE
    assert approved.iam_role_arn
    assert approved.approved_by == "alice@x"
    assert approved.role_expires_at

    got, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.ACTIVE
    assert creds is not None and creds.session_token


async def test_deny_marks_denied_and_removes_policy(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    denied = await svc.deny(request_id=req.request_id, approver="alice@x", reason="nope")
    assert denied.status == RequestStatus.DENIED
    _, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert creds is None


# --- isolation -----------------------------------------------------------
async def test_cross_conversation_isolation(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    got, creds = await svc.status(request_id=req.request_id, conversation_id="c2")
    assert got is None or creds is None


# --- cross-replica: status() re-mints on a cache miss --------------------
# The creds cache is per pod, so a replica that never provisioned a grant must still vend it from the DB.

async def test_status_remints_on_cache_miss_cross_replica(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    # A cleared cache is a replica that never saw this grant.
    svc._creds.clear()
    got, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.ACTIVE
    assert creds is not None and creds.session_token, "cold-pod status() must re-mint, not return None"


async def test_status_cache_miss_with_expired_role_ttl_returns_none(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    svc._creds.clear()
    await svc._store.update(req.request_id, role_expires_at="2000-01-01T00:00:00+00:00")
    got, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.ACTIVE
    assert creds is None


# --- refresh + revoke ----------------------------------------------------
async def test_refresh_mints_new_creds(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    _, c1 = await svc.status(request_id=req.request_id, conversation_id="c1")
    _, c2 = await svc.refresh(request_id=req.request_id, conversation_id="c1")
    assert c2.session_token and c2.session_token != c1.session_token


async def test_revoke_tears_down(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    revoked = await svc.revoke(request_id=req.request_id, conversation_id="c1")
    assert revoked.status == RequestStatus.REVOKED
    _, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert creds is None


# --- supersede: one live grant per (conversation, account) ---------------
# A pending sibling is cancelled at request time; an active sibling keeps working until the new one is approved.

async def test_new_request_supersedes_a_pending_sibling_immediately(tmp_path):
    svc = await make_service(tmp_path)
    r1 = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    r2 = await svc.request(conversation_id="c1", target_account="dev", justification="read+write", policy_document=WRITE)
    g1, _ = await svc.status(request_id=r1.request_id, conversation_id="c1")
    assert g1.status == RequestStatus.SUPERSEDED, f"pending sibling not superseded: {g1.status}"
    assert r2.status == RequestStatus.PENDING


async def test_superseding_a_pending_sibling_withdraws_its_interrupt(tmp_path):
    withdrawn: list[str] = []

    async def on_withdraw(req):
        withdrawn.append(req.request_id)

    svc = await make_service(tmp_path, on_withdraw=on_withdraw)
    r1 = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    assert withdrawn == []
    await svc.request(conversation_id="c1", target_account="dev", justification="read+write",
                      policy_document=WRITE, parent_request_id=r1.request_id)
    assert withdrawn == [r1.request_id]


async def test_a_failing_withdraw_does_not_fail_the_new_request(tmp_path):
    async def on_withdraw(req):
        raise RuntimeError("agent-host down")

    svc = await make_service(tmp_path, on_withdraw=on_withdraw)
    await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    r2 = await svc.request(conversation_id="c1", target_account="dev", justification="+write", policy_document=WRITE)
    assert r2.status == RequestStatus.PENDING


async def test_answering_a_superseded_request_names_its_replacement(tmp_path):
    svc = await make_service(tmp_path)
    r1 = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    r2 = await svc.request(conversation_id="c1", target_account="dev", justification="+write", policy_document=WRITE)
    for answer in (svc.approve(request_id=r1.request_id, approver="a"),
                   svc.deny(request_id=r1.request_id, approver="a", reason="stale")):
        with pytest.raises(NotPending) as exc:
            await answer
        assert exc.value.status == RequestStatus.SUPERSEDED
        assert exc.value.superseded_by == r2.request_id
    g1, _ = await svc.status(request_id=r1.request_id, conversation_id="c1")
    assert g1.status == RequestStatus.SUPERSEDED, "a stale deny must not overwrite superseded"
    assert await svc.can_approve(request_id=r1.request_id, approver="a") is False
    assert await svc.can_approve(request_id=r2.request_id, approver="a") is True


async def test_deny_refuses_an_active_request(tmp_path):
    iam = FakeIam()
    svc = await make_service(tmp_path, iam=iam)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    active = await svc.approve(request_id=req.request_id, approver="a")
    with pytest.raises(NotPending):
        await svc.deny(request_id=req.request_id, approver="a")
    assert active.iam_role_arn in iam.roles
    assert (await svc.status(request_id=req.request_id, conversation_id="c1"))[0].status == RequestStatus.ACTIVE


async def test_active_sibling_kept_until_new_one_is_approved_then_torn_down(tmp_path):
    iam = FakeIam()
    svc = await make_service(tmp_path, iam=iam)
    r1 = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    await svc.approve(request_id=r1.request_id, approver="a")
    r1_role = (await svc.status(request_id=r1.request_id, conversation_id="c1"))[0].iam_role_arn
    assert r1_role in iam.roles

    r2 = await svc.request(conversation_id="c1", target_account="dev", justification="+write", policy_document=WRITE)
    assert (await svc.status(request_id=r1.request_id, conversation_id="c1"))[0].status == RequestStatus.ACTIVE

    await svc.approve(request_id=r2.request_id, approver="a")
    g1 = (await svc.status(request_id=r1.request_id, conversation_id="c1"))[0]
    assert g1.status == RequestStatus.SUPERSEDED, f"active sibling not superseded on approval: {g1.status}"
    assert r1_role not in iam.roles, "the superseded request's IAM role must be torn down"
    g2 = (await svc.status(request_id=r2.request_id, conversation_id="c1"))[0]
    assert g2.status == RequestStatus.ACTIVE


async def test_denied_new_request_leaves_the_active_sibling_intact(tmp_path):
    iam = FakeIam()
    svc = await make_service(tmp_path, iam=iam)
    r1 = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    await svc.approve(request_id=r1.request_id, approver="a")
    r1_role = (await svc.status(request_id=r1.request_id, conversation_id="c1"))[0].iam_role_arn

    r2 = await svc.request(conversation_id="c1", target_account="dev", justification="+write", policy_document=WRITE)
    await svc.deny(request_id=r2.request_id, approver="a", reason="too broad")
    g1 = (await svc.status(request_id=r1.request_id, conversation_id="c1"))[0]
    assert g1.status == RequestStatus.ACTIVE, "a denied expansion must not disturb the original grant"
    assert r1_role in iam.roles


async def test_supersede_is_scoped_to_same_conversation_and_account(tmp_path):
    svc = await make_service(tmp_path)
    r1 = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.request(conversation_id="c1", target_account="prod", justification="x",
                      policy_document={"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "*"}]})
    assert (await svc.status(request_id=r1.request_id, conversation_id="c1"))[0].status == RequestStatus.PENDING
    await svc.request(conversation_id="c2", target_account="dev", justification="x", policy_document=WRITE)
    assert (await svc.status(request_id=r1.request_id, conversation_id="c1"))[0].status == RequestStatus.PENDING


async def test_revoke_does_not_mark_revoked_when_teardown_fails(tmp_path):
    """A failed IAM role teardown must leave the request active so the next sweep or revoke retries it."""
    svc = await make_service(tmp_path, iam=FailingTeardownIam())
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    with pytest.raises(RequestError):
        await svc.revoke(request_id=req.request_id, conversation_id="c1")
    got, _ = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.ACTIVE


async def test_deny_does_not_mark_denied_when_policy_teardown_fails(tmp_path):
    """The same for deny's policy teardown."""
    svc = await make_service(tmp_path, iam=FailingTeardownIam())
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    # Approve first so there is a provisioned policy to tear down.
    await svc.approve(request_id=req.request_id, approver="a")
    with pytest.raises(RequestError):
        await svc.deny(request_id=req.request_id, approver="alice@x", reason="nope")
    got, _ = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status != RequestStatus.DENIED


async def test_sweep_leaves_request_active_when_teardown_fails(tmp_path):
    """A failed teardown inside the grace window leaves the request active for the next sweep."""
    svc = await make_service(tmp_path, iam=FailingTeardownIam())
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    await svc._store.update(req.request_id, role_expires_at="2000-01-01T00:00:00Z")  # type: ignore[attr-defined]
    swept = await svc.sweep_expired()
    assert req.request_id not in swept
    got, _ = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.ACTIVE


async def test_sweep_FORCE_expires_a_zombie_whose_creds_lapsed_past_grace(tmp_path):
    """Past the grace window the sweep force-expires a request whose teardown keeps failing."""
    svc = await make_service(tmp_path, iam=FailingTeardownIam())
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    # Role TTL past and STS creds lapsed longer ago than the grace window.
    await svc._store.update(  # type: ignore[attr-defined]
        req.request_id, role_expires_at="2000-01-01T00:00:00Z", expires_at="2000-01-01T00:00:00Z",
    )
    swept = await svc.sweep_expired()
    assert req.request_id in swept
    got, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.EXPIRED
    assert creds is None


# --- expiry sweep --------------------------------------------------------
async def test_sweep_expires_past_ttl(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    await svc._store.update(req.request_id, role_expires_at="2000-01-01T00:00:00Z")  # type: ignore[attr-defined]
    swept = await svc.sweep_expired()
    assert req.request_id in swept
    got, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.EXPIRED
    assert creds is None


async def test_accounts_exposes_description_and_auto_approve(tmp_path):
    svc = await make_service(tmp_path)
    accts = await svc.accounts()
    assert "off" not in accts
    assert accts["ro"]["description"] == "read-only sandbox"
    assert accts["ro"]["auto_approve_read_only"] is True
    assert accts["dev"]["description"] == ""
    assert accts["dev"]["auto_approve_read_only"] is False
    assert accts["dev"]["account_id"] == "123"


# --- approver identity resolution (configurable claim) --------------------
async def test_resolve_approver_picks_the_configured_claim(tmp_path):
    svc = await make_service(tmp_path)
    ident = {"id": "cognito-sub-abc", "email": "alice@x.io", "name": "Alice"}
    assert svc.resolve_approver(ident, fallback="conv-1") == "alice@x.io"


async def test_resolve_approver_claim_id(tmp_path):
    from scooter_contrib_aws.service import ServiceConfig
    svc = await make_service(tmp_path)
    svc._config = ServiceConfig(broker_principal_arn="arn", approver_claim="id")
    ident = {"id": "sub-xyz", "email": "a@x.io"}
    assert svc.resolve_approver(ident, fallback="conv-1") == "sub-xyz"


async def test_resolve_approver_falls_back_when_claim_missing(tmp_path):
    svc = await make_service(tmp_path)
    assert svc.resolve_approver({"id": "sub-1"}, fallback="conv-1") == "sub-1"
    assert svc.resolve_approver({}, fallback="conv-1") == "conv-1"


async def test_resolve_approver_accepts_a_plain_string_and_strips_user_prefix(tmp_path):
    svc = await make_service(tmp_path)
    assert svc.resolve_approver("bob@x.io", fallback="conv-1") == "bob@x.io"
    assert svc.resolve_approver("user:bob@x.io", fallback="conv-1") == "bob@x.io"
    assert svc.resolve_approver(None, fallback="conv-1") == "conv-1"
