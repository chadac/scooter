from __future__ import annotations

import copy
from dataclasses import dataclass, field

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from scooter_broker_lib.mcp import ToolContext
from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Identity, Provider
from scooter_contrib_k8s import mcp_tools
from scooter_contrib_k8s.config import ClusterConfig
from scooter_contrib_k8s.kube import ExecResult, K8sError, Resource, resolve
from scooter_contrib_k8s.service import Cluster, K8sService
from scooter_contrib_k8s.store import GrantStore, _Base
from scooter_schema.broker import Base

RESOURCES = [
    Resource("v1", "Pod", "pods", True, ("po",)),
    Resource("v1", "Secret", "secrets", True),
    Resource("v1", "ConfigMap", "configmaps", True, ("cm",)),
    Resource("v1", "Event", "events", True, ("ev",)),
    Resource("v1", "Namespace", "namespaces", False, ("ns",)),
    Resource("events.k8s.io/v1", "Event", "events", True, ("ev",)),
    Resource("apps/v1", "Deployment", "deployments", True, ("deploy",)),
]


def merge(a: dict, b: dict) -> dict:
    out = copy.deepcopy(a)
    for k, v in b.items():
        out[k] = merge(out.get(k) or {}, v) if isinstance(v, dict) else copy.deepcopy(v)
    return out


@dataclass
class FakeKube:
    """One cluster in memory: objects by (kind, namespace, name)."""

    objects: dict[tuple, dict] = field(default_factory=dict)
    calls: list[tuple] = field(default_factory=list)
    #: (verb, actor) for every call that took one.
    actors: list[tuple] = field(default_factory=list)
    #: Raised by every dry run, as validation or admission would.
    dry_run_error: K8sError | None = None
    version: int = 0

    def add(self, obj: dict) -> None:
        m = obj["metadata"]
        self.objects[(obj["kind"], m.get("namespace"), m["name"])] = obj

    async def api_resources(self):
        return RESOURCES

    async def resource(self, kind, api_version=""):
        return resolve(RESOURCES, kind, api_version)

    def _find(self, res, name, namespace):
        obj = self.objects.get((res.kind, namespace, name))
        if obj is None:
            raise K8sError(f'404 {res.name} "{name}" not found', 404)
        return obj

    async def list(self, res, namespace, *, label_selector="", field_selector="", limit=0):
        return [copy.deepcopy(o) for (k, ns, _), o in self.objects.items()
                if k == res.kind and (namespace is None or ns == namespace)]

    async def get(self, res, name, namespace, *, actor=None):
        if actor is not None:
            self.actors.append(("get", actor))
        return copy.deepcopy(self._find(res, name, namespace))

    async def logs(self, pod, namespace, **kw):
        self._find(Resource("v1", "Pod", "pods", True), pod, namespace)
        return "line 1\nline 2\n"

    def _write(self, verb, dry_run, actor):
        self.calls.append((verb, dry_run))
        self.actors.append((verb, actor))
        if dry_run and self.dry_run_error:
            raise self.dry_run_error

    async def apply(self, res, body, *, dry_run, actor):
        self._write("apply", dry_run, actor)
        m = body["metadata"]
        live = self.objects.get((res.kind, m.get("namespace"), m["name"]), {})
        out = merge(live, body)
        if not dry_run:
            self.version += 1
            out["metadata"]["resourceVersion"] = str(self.version)
            self.add(out)
        return copy.deepcopy(out)

    async def delete(self, res, name, namespace, *, dry_run, actor):
        self._find(res, name, namespace)
        self._write("delete", dry_run, actor)
        if not dry_run:
            del self.objects[(res.kind, namespace, name)]

    async def patch(self, res, name, namespace, patch, *, dry_run, actor):
        out = merge(self._find(res, name, namespace), patch)
        self._write("patch", dry_run, actor)
        if not dry_run:
            self.add(out)

    async def exec(self, pod, namespace, argv, *, actor, **kw):
        self._write("exec", False, actor)
        return ExecResult(stdout=f"ran {' '.join(argv)}\n", stderr="", exit_code=0)


@dataclass
class FakeCards:
    raised: list[dict] = field(default_factory=list)

    async def raise_(self, conversation_id, contrib, card):
        self.raised.append(card)

    async def withdraw(self, conversation_id, contrib, request_id):
        return None


VIEWS = {
    "conv": {"owner": "alice", "visibility": "shared"},
    "other": {"owner": "alice", "visibility": "shared"},
    "ownerless": {"owner": "", "visibility": "shared"},
}


async def _view(cid):
    return VIEWS.get(cid)


@pytest.fixture
def kube():
    k = FakeKube()
    k.add({"apiVersion": "apps/v1", "kind": "Deployment",
           "metadata": {"name": "web", "namespace": "default", "managedFields": [{"manager": "x"}]},
           "spec": {"replicas": 2, "template": {"metadata": {}, "spec": {}}}, "status": {"readyReplicas": 2}})
    k.add({"apiVersion": "v1", "kind": "Secret", "type": "Opaque",
           "metadata": {"name": "db", "namespace": "default",
                        "annotations": {"kubectl.kubernetes.io/last-applied-configuration": '{"data":{"password":"aHVudGVyMg=="}}'}},
           "data": {"password": "aHVudGVyMg==", "user": "YWRtaW4="}})
    k.add({"apiVersion": "v1", "kind": "Pod", "metadata": {"name": "web-1", "namespace": "default"},
           "spec": {}, "status": {"phase": "Running"}})
    return k


@pytest.fixture
def prod():
    return FakeKube()


@pytest.fixture
async def service(kube, prod):
    clusters = {
        "home": Cluster(ClusterConfig(name="home", auth={"type": "inCluster"}, grants_enabled=True,
                                      grant_max_minutes=30), kube),
        "prod": Cluster(ClusterConfig(name="prod", auth={"type": "inCluster"},
                                      approvers=("admin@example.com",)), prod),
        "ro": Cluster(ClusterConfig(name="ro", auth={"type": "inCluster"}, read_only=True), FakeKube()),
    }
    grants = GrantStore(sqlite_config())
    await create_schema(grants, _Base)
    svc = K8sService(clusters, grants, OwnerResolver(_view, ttl=0))
    return svc


@pytest.fixture
def cards():
    return FakeCards()


@pytest.fixture
async def configured(service, cards):
    service.approvals.configure(sqlite_config(), cards)
    await create_schema(service.approvals, Base)
    mcp_tools.configure(service)
    yield service
    mcp_tools.configure(None)


@pytest.fixture
def app(configured):
    a = FastAPI()

    async def authed() -> Identity:
        return Identity(conversation_id="", namespace="ns", service_account="agent-host", is_approver=True)

    a.include_router(configured.approvals.routes(Provider(name="k8s", transports=[]), authed), prefix="/k8s")
    return a


@pytest.fixture
async def http(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://broker") as c:
        yield c


def ctx(conversation: str = "conv") -> ToolContext:
    return ToolContext(
        identity=Identity(conversation_id=conversation, namespace="ns", service_account="sandbox"),
        provider=Provider(name="k8s", transports=[]),
        upstream=None,  # type: ignore[arg-type]
        links=None,  # type: ignore[arg-type]
    )


def who(user: str, email: str | None = None) -> dict:
    return {"approver": {"id": user, "email": email or f"{user}@example.com"}}
