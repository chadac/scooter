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
from broker.aws.models import RequestStatus, StsCredentials
from broker.aws.service import PermissionService, ServiceConfig, RequestError
from broker.aws.store import PermissionStore, StoreConfig


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
    # Opt-in read-only auto-approval (no human needed for pure-read requests).
    "ro": {"account_id": "999", "broker_role_arn": "arn:...:base", "enabled": True,
           "auto_approve_read_only": True, "description": "read-only sandbox",
           "allowed_policy": {"Statement": [{"Action": ["*"], "Resource": ["*"]}]}},
}

WRITE = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:PutObject", "Resource": "arn:aws:s3:::b/*"}]}

READ = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*"}]}


async def make_service(tmp_path, iam=None):
    cfg = StoreConfig()
    cfg.dsn = f"sqlite+aiosqlite:///{tmp_path / 'broker.db'}"  # local SQLite for tests
    store = PermissionStore(cfg)
    await store.init()
    svc = PermissionService(
        store=store,
        iam=iam or FakeIam(),
        account_registry=REGISTRY,
        config=ServiceConfig(broker_principal_arn="arn:...:broker"),
    )
    return svc


class FailingTeardownIam(FakeIam):
    """FakeIam whose teardown ALWAYS fails (returns False), as the real helper
    does on a non-NoSuchEntity AWS error. Findings #6/#19."""

    def delete_dynamic_policy(self, *, target_account, policy_arn):
        return False

    def delete_dynamic_role(self, *, target_account, role_arn, policy_arn):
        return False


class _FakeClientError(Exception):
    """Mimics botocore.exceptions.ClientError enough for _aws_error_reasons:
    a `.response` dict + `.operation_name`."""

    def __init__(self):
        super().__init__("An error occurred (AccessDenied) when calling AssumeRole")
        self.operation_name = "AssumeRole"
        self.response = {
            "Error": {"Code": "AccessDenied", "Message": "not authorized to perform sts:AssumeRole"},
            "ResponseMetadata": {"HTTPStatusCode": 403, "RequestId": "req-123"},
        }


class PolicyFailingIam(FakeIam):
    """create_dynamic_policy raises a boto-like ClientError (the account's broker
    IAM isn't set up → STS AssumeRole denied) — the real 500-cause the user hit."""

    def create_dynamic_policy(self, *, target_account, request_id, policy_document):
        raise _FakeClientError()


# --- request -------------------------------------------------------------
async def test_request_creates_pending(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="read a file", policy_document=READ)
    assert req.status == RequestStatus.PENDING
    assert req.request_id
    assert req.conversation_id == "c1"
    # IAM provisioning is DEFERRED to approval now, so no policy ARN yet — the
    # request always lands PENDING (and shows in the UI) regardless of IAM setup.
    assert req.iam_policy_arn is None


async def test_readonly_request_auto_approves_when_account_opts_in(tmp_path):
    # The "ro" account has auto_approve_read_only=true; a pure-read request is
    # granted immediately (ACTIVE + creds), no human, recorded as the system approver.
    from broker.aws.service import AUTO_APPROVE_PRINCIPAL

    notified = []
    svc = await make_service(tmp_path)
    svc._on_request = lambda req: notified.append(req)  # type: ignore[assignment]

    req = await svc.request(conversation_id="c1", target_account="ro", justification="read", policy_document=READ)
    assert req.status == RequestStatus.ACTIVE
    assert req.approved_by == AUTO_APPROVE_PRINCIPAL
    assert req.iam_role_arn  # a role was provisioned
    # Creds are cached (status() returns them) and NO approval interrupt was raised.
    got_req, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got_req is not None and creds is not None
    assert notified == []  # auto-approved -> the host was never notified


class ExpiringIam(FakeIam):
    """Mints an ALREADY-EXPIRED token on create (the role-chained STS token that has
    outlived its ~1h cap), and a FRESH far-future token on refresh — so we can prove
    status() re-vends instead of handing back the stale cached token."""

    def create_dynamic_role(self, *, target_account, request_id, policy_arn, managed_policy_arns, duration_seconds):
        self._n += 1
        arn = f"arn:aws:iam::123:role/agent-broker-{request_id}"
        self.roles[arn] = {"policy_arn": policy_arn, "managed": managed_policy_arns}
        # expires in the PAST (the reported bug: cached token already stale)
        return arn, StsCredentials("AKIA", "secret", "STALE", "us-east-1", "2000-01-01T00:00:00Z")

    def assume_dynamic_role(self, *, target_account, role_arn, request_id, duration_seconds):
        self._n += 1
        return StsCredentials("AKIA", "secret", "FRESH", "us-east-1", "2030-01-01T00:00:00Z")


async def test_status_auto_refreshes_an_expired_cached_token(tmp_path):
    # THE bug: the dynamic role is valid for 12h but the STS token is capped at ~1h,
    # so the cached token expires while the request is still ACTIVE. status() (the
    # path the sandbox credential_process hits every call) must detect the stale token
    # and re-vend a fresh one from the still-valid role — not return the expired one.
    svc = await make_service(tmp_path, iam=ExpiringIam())
    req = await svc.request(conversation_id="c1", target_account="ro", justification="read", policy_document=READ)
    assert req.status == RequestStatus.ACTIVE

    got_req, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got_req is not None and creds is not None
    assert creds.session_token == "FRESH", "status() must auto-refresh the stale token"
    assert creds.expires_at == "2030-01-01T00:00:00Z"


async def test_status_returns_no_creds_when_role_TTL_has_passed(tmp_path):
    # If even the ROLE TTL has elapsed, a refresh can't help — return no creds so the
    # agent re-requests (rather than looping on a dead role).
    svc = await make_service(tmp_path, iam=ExpiringIam())
    req = await svc.request(conversation_id="c1", target_account="ro", justification="read", policy_document=READ)
    # Force the role TTL into the past.
    await svc._store.update(req.request_id, role_expires_at="2000-01-01T00:00:00Z")

    got_req, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got_req is not None
    assert creds is None, "role TTL gone -> no creds; the agent must request again"


async def test_write_request_on_autoapprove_account_still_needs_a_human(tmp_path):
    # Same opt-in account, but a WRITE action -> stays PENDING (auto-approve is
    # read-only only), and the host IS notified.
    notified = []
    svc = await make_service(tmp_path)
    svc._on_request = lambda req: notified.append(req)  # type: ignore[assignment]

    req = await svc.request(conversation_id="c1", target_account="ro", justification="write", policy_document=WRITE)
    assert req.status == RequestStatus.PENDING
    assert len(notified) == 1


async def test_readonly_request_without_optin_stays_pending(tmp_path):
    # The "dev" account does NOT opt in -> even a read-only request needs a human.
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    assert req.status == RequestStatus.PENDING


async def test_request_appears_pending_even_when_iam_is_unprovisioned(tmp_path):
    # Notify-first: the request must land PENDING (and notify) even when the
    # account's broker IAM isn't set up — provisioning is deferred to approve, so
    # the request appears in the conversation instead of failing before it shows.
    notified = []
    svc = await make_service(tmp_path, iam=PolicyFailingIam())
    svc._on_request = lambda req: notified.append(req)  # type: ignore[assignment]
    req = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    assert req.status == RequestStatus.PENDING
    assert req.iam_policy_arn is None
    assert len(notified) == 1  # the UI WAS notified (the interrupt will show)


async def test_iam_provisioning_failure_at_APPROVE_is_a_verbose_error(tmp_path):
    # When IAM isn't set up, the failure now surfaces on APPROVE with the FULL AWS
    # detail (code, message, operation, HTTP status, request id) + the actionable
    # "broker isn't set up" guidance — fed back to the agent so it can help fix it.
    svc = await make_service(tmp_path, iam=PolicyFailingIam())
    req = await svc.request(conversation_id="c1", target_account="dev", justification="read", policy_document=READ)
    with pytest.raises(RequestError) as ei:
        await svc.approve(request_id=req.request_id, approver="admin@x.io")
    blob = " | ".join(ei.value.reasons)
    assert "AccessDenied" in blob
    assert "sts:AssumeRole" in blob
    assert "AssumeRole" in blob            # the failing operation
    assert "403" in blob and "req-123" in blob  # HTTP status + request id
    assert "isn't set up yet" in blob      # the actionable diagnosis
    # The request is left in ERROR (not silently pending) with the detail recorded.
    got = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got[0] is not None and got[0].status == RequestStatus.ERROR


async def test_request_rejects_blocked_action(tmp_path):
    svc = await make_service(tmp_path)
    bad = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "iam:CreateRole", "Resource": "*"}]}
    with pytest.raises(RequestError):
        await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=bad)


async def test_request_rejects_out_of_bounds(tmp_path):
    svc = await make_service(tmp_path)
    # prod only allows s3:Get*; a PutObject is out of bounds.
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
    # No creds available on a denied request.
    _, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert creds is None


# --- isolation -----------------------------------------------------------
async def test_cross_conversation_isolation(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    # Another conversation cannot read c1's request/creds.
    got, creds = await svc.status(request_id=req.request_id, conversation_id="c2")
    assert got is None or creds is None


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


async def test_revoke_does_not_mark_revoked_when_teardown_fails(tmp_path):
    """Finding #6: a failed IAM role teardown must NOT flip the request to a
    terminal REVOKED status — that orphans a live role behind a status the sweep
    never revisits. Raise + keep it ACTIVE so the next sweep/revoke retries."""
    svc = await make_service(tmp_path, iam=FailingTeardownIam())
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    with pytest.raises(RequestError):
        await svc.revoke(request_id=req.request_id, conversation_id="c1")
    got, _ = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.ACTIVE  # NOT revoked — still cleanable


async def test_deny_does_not_mark_denied_when_policy_teardown_fails(tmp_path):
    """Finding #19: same for deny's policy teardown."""
    svc = await make_service(tmp_path, iam=FailingTeardownIam())
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    # Give it a policy to tear down (request creates one at approve; for deny we
    # need iam_policy_arn set — approve to provision, then deny).
    await svc.approve(request_id=req.request_id, approver="a")
    with pytest.raises(RequestError):
        await svc.deny(request_id=req.request_id, approver="alice@x", reason="nope")
    got, _ = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status != RequestStatus.DENIED


async def test_sweep_leaves_request_active_when_teardown_fails(tmp_path):
    """Finding #6: the sweep must NOT mark EXPIRED on a failed teardown WITHIN the
    grace window — leave it selectable so the next sweep retries instead of orphaning
    the role. (Its STS creds are still recent here, so it's inside the grace window.)"""
    svc = await make_service(tmp_path, iam=FailingTeardownIam())
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    await svc._store.update(req.request_id, role_expires_at="2000-01-01T00:00:00Z")  # type: ignore[attr-defined]
    swept = await svc.sweep_expired()
    assert req.request_id not in swept  # teardown failed, still in grace -> not swept
    got, _ = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.ACTIVE  # left for retry


async def test_sweep_FORCE_expires_a_zombie_whose_creds_lapsed_past_grace(tmp_path):
    """The bug report's zombie: teardown PERMANENTLY fails (IAM AccessDenied), so a
    request whose STS creds lapsed hours ago would stay 'active' forever — and the
    credential helper could keep picking it as a stale source. Past the grace window
    the sweep force-expires it anyway (the orphaned role is reclaimed later)."""
    svc = await make_service(tmp_path, iam=FailingTeardownIam())
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    # Role TTL past (so the sweep considers it) AND STS creds lapsed long ago (> grace).
    await svc._store.update(  # type: ignore[attr-defined]
        req.request_id, role_expires_at="2000-01-01T00:00:00Z", expires_at="2000-01-01T00:00:00Z",
    )
    swept = await svc.sweep_expired()
    assert req.request_id in swept  # force-expired despite teardown failure
    got, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.EXPIRED
    assert creds is None


# --- expiry sweep --------------------------------------------------------
async def test_sweep_expires_past_ttl(tmp_path):
    svc = await make_service(tmp_path)
    req = await svc.request(conversation_id="c1", target_account="dev", justification="x", policy_document=READ)
    await svc.approve(request_id=req.request_id, approver="a")
    # Force the role TTL into the past, then sweep.
    await svc._store.update(req.request_id, role_expires_at="2000-01-01T00:00:00Z")  # type: ignore[attr-defined]
    swept = await svc.sweep_expired()
    assert req.request_id in swept
    got, creds = await svc.status(request_id=req.request_id, conversation_id="c1")
    assert got.status == RequestStatus.EXPIRED
    assert creds is None


async def test_accounts_exposes_description_and_auto_approve(tmp_path):
    # The agent discovers accounts via accounts() (GET /aws/accounts): each carries
    # a human `description` + the `auto_approve_read_only` flag so it can pick the
    # right one. Disabled accounts are omitted.
    svc = await make_service(tmp_path)
    accts = await svc.accounts()
    assert "off" not in accts  # disabled -> not offered
    assert accts["ro"]["description"] == "read-only sandbox"
    assert accts["ro"]["auto_approve_read_only"] is True
    # An account with no description/flag still reports safe defaults.
    assert accts["dev"]["description"] == ""
    assert accts["dev"]["auto_approve_read_only"] is False
    assert accts["dev"]["account_id"] == "123"


# --- approver identity resolution (configurable claim) --------------------
async def test_resolve_approver_picks_the_configured_claim(tmp_path):
    svc = await make_service(tmp_path)  # default approver_claim = "email"
    ident = {"id": "cognito-sub-abc", "email": "alice@x.io", "name": "Alice"}
    assert svc.resolve_approver(ident, fallback="conv-1") == "alice@x.io"


async def test_resolve_approver_claim_id(tmp_path):
    from broker.aws.service import ServiceConfig
    svc = await make_service(tmp_path)
    svc._config = ServiceConfig(broker_principal_arn="arn", approver_claim="id")
    ident = {"id": "sub-xyz", "email": "a@x.io"}
    assert svc.resolve_approver(ident, fallback="conv-1") == "sub-xyz"


async def test_resolve_approver_falls_back_when_claim_missing(tmp_path):
    svc = await make_service(tmp_path)  # email claim
    # No email in the identity → fall back to id, then to `fallback`.
    assert svc.resolve_approver({"id": "sub-1"}, fallback="conv-1") == "sub-1"
    assert svc.resolve_approver({}, fallback="conv-1") == "conv-1"


async def test_resolve_approver_accepts_a_plain_string_and_strips_user_prefix(tmp_path):
    svc = await make_service(tmp_path)
    assert svc.resolve_approver("bob@x.io", fallback="conv-1") == "bob@x.io"
    assert svc.resolve_approver("user:bob@x.io", fallback="conv-1") == "bob@x.io"
    assert svc.resolve_approver(None, fallback="conv-1") == "conv-1"
