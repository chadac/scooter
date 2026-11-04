"""HTTP-level tests for the aws-permissions transport with a mocked identity and a fake IAM.

A minimal app mounts only the AWS transport with an explicitly constructed service,
so there is no cross-file test pollution.
"""

from __future__ import annotations

import pytest

pytest.importorskip("sqlalchemy")
pytest.importorskip("aiosqlite")

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from scooter_contrib_aws.iam import IamProvisioner  # noqa: E402
from scooter_contrib_aws.models import StsCredentials  # noqa: E402
from scooter_contrib_aws.service import PermissionService, ServiceConfig  # noqa: E402
from scooter_contrib_aws.store import PermissionStore  # noqa: E402
from scooter_broker_lib.store import StoreConfig  # noqa: E402
from scooter_broker_lib.types import Identity  # noqa: E402


async def authenticate() -> Identity:  # pragma: no cover
    """A stand-in for the app's auth dependency, replaced via app.dependency_overrides before any request."""
    raise AssertionError("dependency_overrides should have replaced this")
from scooter_contrib_aws.permissions_transport import AwsPermissions  # noqa: E402

from scooter_broker_lib.testing import create_schema
from scooter_contrib_aws import store as aws_store

from rule_sets import compiled

REGISTRY = {
    "dev": {"account_id": "123", "broker_role_arn": "arn:...:base", "enabled": True,
            "allowed_policy": {"Statement": [{"Action": ["s3:*"], "Resource": ["*"]}]},
            "approval_rules": compiled()},
}
POLICY = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "s3:GetObject", "Resource": "arn:aws:s3:::b/*"}]}


class FakeIam(IamProvisioner):
    def __init__(self):
        self._n = 0

    def create_dynamic_policy(self, **kw):
        return f"arn:aws:iam::123:policy/agent-broker-{kw['request_id']}"

    def create_dynamic_role(self, **kw):
        self._n += 1
        return (f"arn:aws:iam::123:role/agent-broker-{kw['request_id']}",
                StsCredentials("AKIA", "sec", f"tok{self._n}", "us-east-1", "2030-01-01T00:00:00Z"))

    def assume_dynamic_role(self, **kw):
        self._n += 1
        return StsCredentials("AKIA", "sec", f"tok{self._n}", "us-east-1", "2030-01-01T00:00:00Z")

    def delete_dynamic_policy(self, **kw):
        return True

    def delete_dynamic_role(self, **kw):
        return True


def _identity(cid: str):
    return lambda: Identity(
        conversation_id=cid, namespace="agent-sandbox",
        service_account=f"system:serviceaccount:agent-sandbox:sandbox-{cid}",
    )


def _app(tmp_path):
    """A minimal FastAPI app mounting only the AWS transport over a FakeIam and SQLite."""
    store = PermissionStore(StoreConfig(dsn=f"sqlite+aiosqlite:///{tmp_path / 'broker.db'}"))
    service = PermissionService(
        store=store, iam=FakeIam(), account_registry=REGISTRY,
        config=ServiceConfig(broker_principal_arn="arn:...:broker"),
    )
    transport = AwsPermissions()
    transport.set_service(service, is_admin=None)

    import contextlib

    @contextlib.asynccontextmanager
    async def lifespan(app):
        await create_schema(store, aws_store._Base)
        yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(transport.routes(provider=None, authed=authenticate), prefix="/aws")
    return app


def test_request_approve_status_flow(tmp_path):
    app = _app(tmp_path)
    app.dependency_overrides[authenticate] = _identity("conv-1")
    with TestClient(app) as client:
        r = client.get("/aws/aws/accounts")
        assert r.status_code == 200 and "dev" in r.json()["accounts"]

        r = client.post("/aws/aws/request", json={"target_account": "dev", "policy_document": POLICY, "justification": "read"})
        assert r.status_code == 201, r.text
        rid = r.json()["request_id"]
        assert r.json()["status"] == "pending"

        r = client.get(f"/aws/aws/{rid}")
        assert r.json()["status"] == "pending"
        assert "credentials" not in r.json()

        r = client.post(f"/aws/aws/{rid}/approve", json={"approver": "alice@x"})
        assert r.status_code == 200 and r.json()["status"] == "active"
        assert "approved by alice@x" in r.json()["agent_message"]
        assert "aws --profile dev" in r.json()["agent_message"]
        # The agent's own status view carries no wake-up prose.
        assert "agent_message" not in client.get(f"/aws/aws/{rid}").json()
        r = client.get(f"/aws/aws/{rid}")
        assert r.json()["status"] == "active"
        assert r.json()["credentials"]["session_token"]


def test_deny_tells_the_agent_who_denied_and_why(tmp_path):
    app = _app(tmp_path)
    app.dependency_overrides[authenticate] = _identity("conv-1")
    with TestClient(app) as client:
        r = client.post("/aws/aws/request", json={"target_account": "dev", "policy_document": POLICY, "justification": "read"})
        rid = r.json()["request_id"]
        r = client.post(f"/aws/aws/{rid}/deny", json={"approver": "alice@x", "reason": "too broad"})
        assert r.status_code == 200 and r.json()["status"] == "denied"
        msg = r.json()["agent_message"]
        assert "denied by alice@x" in msg and "too broad" in msg


def test_pending_route_lists_a_named_conversations_pending_requests(tmp_path):
    app = _app(tmp_path)
    app.dependency_overrides[authenticate] = _identity("conv-A")
    with TestClient(app) as client:
        r = client.post("/aws/aws/request", json={"target_account": "dev", "policy_document": POLICY, "justification": "write"})
        assert r.status_code == 201 and r.json()["status"] == "pending"
        rid = r.json()["request_id"]

    app.dependency_overrides[authenticate] = _identity("agent-host")
    with TestClient(app) as client:
        r = client.get("/aws/aws/pending", params={"conversation_id": "conv-A"})
        assert r.status_code == 200, r.text
        ids = [x["request_id"] for x in r.json()["requests"]]
        assert rid in ids, ids
        r = client.get("/aws/aws/pending", params={"conversation_id": "conv-OTHER"})
        assert r.json()["requests"] == []
        r = client.get("/aws/aws/pending")
        assert r.status_code == 400


def test_blocked_policy_is_rejected(tmp_path):
    app = _app(tmp_path)
    app.dependency_overrides[authenticate] = _identity("conv-1")
    bad = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Action": "iam:CreateRole", "Resource": "*"}]}
    with TestClient(app) as client:
        r = client.post("/aws/aws/request", json={"target_account": "dev", "policy_document": bad, "justification": "x"})
    assert r.status_code == 400
    assert "errors" in r.json()["detail"]


def test_cross_conversation_isolation_over_http(tmp_path):
    app = _app(tmp_path)
    with TestClient(app) as client:
        app.dependency_overrides[authenticate] = _identity("conv-1")
        rid = client.post("/aws/aws/request", json={"target_account": "dev", "policy_document": POLICY, "justification": "x"}).json()["request_id"]
        app.dependency_overrides[authenticate] = _identity("conv-2")
        assert client.get(f"/aws/aws/{rid}").status_code == 404


class _FakeAuthorizer:
    def __init__(self, allowed):
        self.allowed = allowed

    async def check(self, *, user, relation, obj):
        return (user, relation, obj) in self.allowed

    async def grant(self, *, user, relation, obj):
        pass


def test_can_approve_route_reflects_the_openfga_check(tmp_path):
    """The read-only /can-approve route answers per viewer without mutating."""
    # The authorizer is seeded the way seed_approver_tuples() does, as `user:<id>`.
    authz = _FakeAuthorizer({("user:alice@x", "approver", "aws_account:dev")})
    store = PermissionStore(StoreConfig(dsn=f"sqlite+aiosqlite:///{tmp_path / 'ca.db'}"))
    service = PermissionService(
        store=store, iam=FakeIam(), account_registry=REGISTRY,
        config=ServiceConfig(broker_principal_arn="arn:...:broker"), authorizer=authz,
    )
    transport = AwsPermissions()
    transport.set_service(service, is_admin=None)

    import contextlib

    @contextlib.asynccontextmanager
    async def lifespan(app):
        await create_schema(store, aws_store._Base)
        yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(transport.routes(provider=None, authed=authenticate), prefix="/aws")
    app.dependency_overrides[authenticate] = _identity("conv-1")

    with TestClient(app) as client:
        rid = client.post(
            "/aws/aws/request",
            json={"target_account": "dev", "policy_document": POLICY, "justification": "x"},
        ).json()["request_id"]

        r = client.post(f"/aws/aws/{rid}/can-approve", json={"approver": {"id": "alice@x", "email": "alice@x"}})
        assert r.status_code == 200 and r.json()["can_approve"] is True

        r = client.post(f"/aws/aws/{rid}/can-approve", json={"approver": {"id": "bob@x", "email": "bob@x"}})
        assert r.status_code == 200 and r.json()["can_approve"] is False

        assert client.get(f"/aws/aws/{rid}").json()["status"] == "pending"


def test_approve_requires_approver_identity(tmp_path):
    """approve/deny are gated on is_approver, so a sandbox identity gets 403."""
    store = PermissionStore(StoreConfig(dsn=f"sqlite+aiosqlite:///{tmp_path / 'b.db'}"))
    service = PermissionService(store=store, iam=FakeIam(), account_registry=REGISTRY,
                                config=ServiceConfig(broker_principal_arn="arn:...:broker"))
    transport = AwsPermissions()
    transport.set_service(service, is_admin=lambda identity: identity.is_approver)

    import contextlib
    from fastapi import FastAPI

    @contextlib.asynccontextmanager
    async def lifespan(app):
        await create_schema(store, aws_store._Base)
        yield

    app = FastAPI(lifespan=lifespan)
    app.include_router(transport.routes(provider=None, authed=authenticate), prefix="/aws")

    with TestClient(app) as client:
        app.dependency_overrides[authenticate] = _identity("conv-1")
        rid = client.post("/aws/aws/request", json={"target_account": "dev", "policy_document": POLICY, "justification": "x"}).json()["request_id"]
        assert client.post(f"/aws/aws/{rid}/approve").status_code == 403

        app.dependency_overrides[authenticate] = lambda: Identity(
            conversation_id="", namespace="agent-sandbox",
            service_account="system:serviceaccount:agent-manager:agent-host", is_approver=True,
        )
        assert client.post(f"/aws/aws/{rid}/approve").status_code == 200
