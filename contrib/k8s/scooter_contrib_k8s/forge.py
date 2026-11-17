"""kubectl and helm through the broker's forge proxy: one virtual host per cluster.

The sandbox's kubeconfig points each cluster at `<name>.k8s.scooter`. The proxy
routes it here: `KubePolicy` decides, `KubeCredential` adds the token (and
`Impersonate-*` for privileged calls) and `KubeTransport` sends it to the real API
server over the cluster's own TLS settings.
"""

from __future__ import annotations

import asyncio
import json
import ssl
import time
from dataclasses import dataclass
from urllib.parse import parse_qs, unquote

import certifi
import httpx

from scooter_broker_lib.forge import Decision, ForgeRequest
from scooter_broker_lib.types import Credential, Identity

from .auth import ClusterAuth
from .config import ClusterConfig
from .store import GrantStore

HOST_SUFFIX = ".k8s.scooter"
# Helm's release Secrets, readable under a write grant.
HELM_RELEASE_PREFIX = "sh.helm.release.v1."
_READS = frozenset({"GET", "HEAD", "OPTIONS"})
_STREAMS = frozenset({"exec", "attach", "portforward"})


def host_for(name: str) -> str:
    return f"{name}{HOST_SUFFIX}"


def cluster_of(host: str) -> str:
    return host.removesuffix(HOST_SUFFIX) if host.endswith(HOST_SUFFIX) else ""


@dataclass(frozen=True)
class KubeRequest:
    """A request path as the API server reads it."""

    method: str
    # "" for the core group; None for a non-resource path such as /version.
    group: str | None
    resource: str = ""
    namespace: str = ""
    name: str = ""
    subresource: str = ""
    watch: bool = False
    dry_run: bool = False
    label_selector: str = ""

    @property
    def write(self) -> bool:
        return self.method not in _READS

    @property
    def secret(self) -> bool:
        return self.group == "" and self.resource == "secrets"

    @property
    def privileged(self) -> bool:
        """Runs as the impersonated user: writes and Secret reads."""
        return self.write or self.secret

    @property
    def helm_selector(self) -> bool:
        terms = {t.replace(" ", "") for t in self.label_selector.split(",")}
        return bool(terms & {"owner=helm", "owner==helm"})


def parse(method: str, path: str, query: str = "") -> KubeRequest:
    method = method.upper()
    q = parse_qs(query)
    flag = lambda k: (q.get(k) or [""])[-1].lower() in ("1", "true")  # noqa: E731
    parts = [unquote(p) for p in path.strip("/").split("/") if p]
    if parts[:1] == ["api"] and len(parts) >= 2:
        group, rest = "", parts[2:]
    elif parts[:1] == ["apis"] and len(parts) >= 3:
        group, rest = parts[1], parts[3:]
    else:
        return KubeRequest(method=method, group=None)
    watch = flag("watch")
    if rest[:1] == ["watch"]:
        watch, rest = True, rest[1:]
    namespace = ""
    if len(rest) >= 3 and rest[0] == "namespaces" and rest[2] not in ("status", "finalize"):
        namespace, rest = rest[1], rest[2:]
    resource, name, sub = (rest + ["", "", ""])[:3]
    return KubeRequest(
        method=method, group=group, resource=resource, namespace=namespace, name=name,
        subresource="/".join(rest[2:]) if sub else "", watch=watch and not name,
        dry_run=(q.get("dryRun") or [""])[-1] == "All",
        label_selector=(q.get("labelSelector") or [""])[-1],
    )


class KubePolicy:
    """Reads pass; writes need a write grant; Secrets need a Secret grant; streams stay on k8s_exec."""

    def __init__(self, clusters: dict[str, ClusterConfig], grants: GrantStore | None) -> None:
        self._clusters = clusters
        self._grants = grants

    async def check(self, request: ForgeRequest) -> Decision:
        cfg = self._clusters.get(cluster_of(request.host))
        if cfg is None:
            return Decision.deny(f"no cluster for host {request.host}")
        r = parse(request.method, request.path, request.query)
        sub = r.subresource.partition("/")[0]
        if sub in _STREAMS:
            return Decision.deny(f"{sub} is not carried by the proxy; use the k8s_exec tool")
        if sub == "proxy":
            return Decision.deny("API server proxying is not carried by the proxy")
        if r.group is None:
            return Decision.allow() if not r.write else Decision.deny("only reads of non-resource paths")
        if not r.privileged:
            return Decision.allow()
        if cfg.read_only:
            return Decision.deny(f"cluster {cfg.name} is read-only here")
        if r.write and r.dry_run:
            return Decision.allow("dry run")
        cid = request.identity.conversation_id
        if not cid or self._grants is None:
            return Decision.deny("no conversation to hold a grant")
        if r.write:
            return await self._write(cfg, cid, r)
        return await self._secret_read(cfg, cid, r)

    async def _write(self, cfg: ClusterConfig, cid: str, r: KubeRequest) -> Decision:
        if not r.namespace:
            return Decision.deny("cluster-scoped writes need their own approval: use k8s_apply or k8s_delete")
        if await self._grant(cid, cfg.name, r.namespace, "write"):
            return Decision.allow("write grant")
        return Decision.deny(self._no_grant(cfg, r.namespace))

    async def _secret_read(self, cfg: ClusterConfig, cid: str, r: KubeRequest) -> Decision:
        if not r.namespace:
            return Decision.deny("Secrets are read one namespace at a time")
        helm = r.name.startswith(HELM_RELEASE_PREFIX) if r.name else r.helm_selector
        if helm and await self._grant(cid, cfg.name, r.namespace, "write"):
            return Decision.allow("helm release under write grant")
        if r.name and not r.subresource:
            for g in await self._grants.active(cid, cfg.name, r.namespace, kind="secret"):
                if r.name in g.names:
                    return Decision.allow("secret grant")
            return Decision.deny(
                f"reading Secret {r.namespace}/{r.name} needs a grant: call k8s_request_secret_access"
            )
        return Decision.deny("Secrets can't be listed or watched; read them by name under k8s_request_secret_access")

    async def _grant(self, cid: str, cluster: str, namespace: str, kind: str):
        found = await self._grants.active(cid, cluster, namespace, kind=kind)
        return found[0] if found else None

    def _no_grant(self, cfg: ClusterConfig, namespace: str) -> str:
        if not cfg.grants_enabled:
            return f"cluster {cfg.name} takes writes only through k8s_apply and the other k8s_* tools"
        return f"writes in {namespace} need a write grant: call k8s_request_grant (then retry)"

    async def approver(self, identity: Identity, host: str, r: KubeRequest) -> str:
        """Who approved the grant a privileged call runs under; "" when none applies."""
        if not r.namespace or self._grants is None or not identity.conversation_id:
            return ""
        kind = "secret" if r.secret and not r.write and not r.name.startswith(HELM_RELEASE_PREFIX) else "write"
        g = await self._grant(identity.conversation_id, cluster_of(host), r.namespace, kind)
        return g.approved_by if g else ""


@dataclass(frozen=True)
class _Conn:
    base: httpx.URL
    config: object
    transport: httpx.AsyncBaseTransport
    tls_key: tuple


class ClusterLink:
    """A cluster's API server address, token and TLS, rebuilt after `auth.ttl`."""

    def __init__(self, auth: ClusterAuth, *, inner=None) -> None:
        self._auth = auth
        self._inner = inner
        self._conn: _Conn | None = None
        self._built = 0.0
        self._lock = asyncio.Lock()

    async def current(self) -> _Conn:
        async with self._lock:
            ttl = self._auth.ttl
            if self._conn is None or (ttl is not None and time.monotonic() - self._built > ttl):
                cfg = await self._auth.configuration()
                key = (cfg.host, cfg.ssl_ca_cert, cfg.cert_file, cfg.key_file, cfg.verify_ssl)
                transport = (self._conn.transport if self._conn and self._conn.tls_key == key
                             else self._inner or httpx.AsyncHTTPTransport(verify=_ssl(cfg)))
                self._conn = _Conn(httpx.URL(cfg.host), cfg, transport, key)
                self._built = time.monotonic()
            return self._conn

    async def token(self) -> str:
        # Read per call: inCluster's hook re-reads the rotated token.
        return (await self.current()).config.get_api_key_with_prefix("authorization") or ""


def _ssl(cfg) -> ssl.SSLContext:
    ctx = ssl.create_default_context(cafile=cfg.ssl_ca_cert or certifi.where())
    if cfg.cert_file:
        ctx.load_cert_chain(cfg.cert_file, cfg.key_file)
    if not cfg.verify_ssl:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


class KubeTransport(httpx.AsyncBaseTransport):
    """Sends a request for `<name>.k8s.scooter` to the cluster's real API server."""

    def __init__(self, link: ClusterLink) -> None:
        self._link = link

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        conn = await self._link.current()
        base = conn.base
        request.url = request.url.copy_with(
            scheme=base.scheme, host=base.host, port=base.port,
            raw_path=base.raw_path.rstrip(b"/") + request.url.raw_path,
        )
        request.headers["Host"] = base.netloc.decode("ascii")
        return await conn.transport.handle_async_request(request)


class KubeCredential:
    """The cluster's token, plus `Impersonate-*` for writes and Secret reads."""

    def __init__(self, clusters: dict[str, ClusterConfig], links: dict[str, ClusterLink],
                 policy: KubePolicy) -> None:
        self._clusters = clusters
        self._links = links
        self._policy = policy

    async def get(self, identity: Identity, request: ForgeRequest | None = None) -> Credential:
        if request is None:
            raise ValueError("a k8s credential is for one request")
        name = cluster_of(request.host)
        headers: dict[str, str] = {}
        token = await self._links[name].token()
        if token:
            headers["Authorization"] = token
        user = self._clusters[name].impersonate
        r = parse(request.method, request.path, request.query)
        if user and r.privileged:
            headers["Impersonate-User"] = user
            headers["Impersonate-Extra-scooter-conversation"] = identity.conversation_id
            approver = await self._policy.approver(identity, request.host, r)
            if approver:
                headers["Impersonate-Extra-scooter-approver"] = approver
        return Credential(kind="multi-header", value=json.dumps(headers))
