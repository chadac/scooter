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

from .auth import ClusterAuth, Endpoint
from .config import ClusterConfig
from .store import GrantStore

HOST_SUFFIX = ".k8s.scooter"
# Helm's release Secrets, readable by anyone who can read the cluster.
HELM_RELEASE_PREFIX = "sh.helm.release.v1."
HELM_RELEASE_TYPE = "helm.sh/release.v1"
_READS = frozenset({"GET", "HEAD", "OPTIONS"})
_STREAMS = frozenset({"exec", "attach", "portforward"})


def status_body(code: int, message: str) -> dict:
    """A metav1.Status, which kubectl and helm print; they show a bare message as "unknown"."""
    reason = {403: "Forbidden", 413: "RequestEntityTooLarge"}.get(code, "")
    return {"kind": "Status", "apiVersion": "v1", "metadata": {}, "status": "Failure",
            "message": message, "reason": reason, "code": code}


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
    def helm_read(self) -> bool:
        """A read of Helm's release Secrets, which KubeTransport holds to that type."""
        if not self.secret or self.write or self.watch or self.subresource:
            return False
        return self.name.startswith(HELM_RELEASE_PREFIX) if self.name else self.helm_selector

    @property
    def privileged(self) -> bool:
        """Runs as the impersonated user: writes and Secret reads."""
        return self.write or (self.secret and not self.helm_read)

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


@dataclass(frozen=True)
class Verdict:
    """A policy decision, and whom an allowed call runs as."""

    decision: Decision
    # Run as the cluster's `impersonate` user rather than the broker.
    impersonate: bool = False
    approver: str = ""

    @classmethod
    def deny(cls, reason: str) -> "Verdict":
        return cls(Decision.deny(reason))


class KubePolicy:
    """Reads pass; writes need a write grant; Secrets need a Secret grant; streams stay on k8s_exec.

    Two inputs only the broker's own tools can set: `approver`, for a call a person
    approved on its card, and `redacted`, for a Secret read whose values the tool hides.
    """

    def __init__(self, clusters: dict[str, ClusterConfig], grants: GrantStore | None) -> None:
        self._clusters = clusters
        self._grants = grants

    async def check(self, request: ForgeRequest) -> Decision:
        r = parse(request.method, request.path, request.query)
        v = await self.evaluate(cluster_of(request.host), request.identity.conversation_id, r)
        return v.decision

    async def evaluate(self, cluster: str, cid: str, r: KubeRequest, *, approver: str = "",
                       redacted: bool = False) -> Verdict:
        cfg = self._clusters.get(cluster)
        if cfg is None:
            return Verdict.deny(f"no cluster {cluster or '(none)'}")
        sub = r.subresource.partition("/")[0]
        if sub in _STREAMS:
            if approver and not cfg.read_only:
                return Verdict(Decision.allow("approved"), impersonate=True, approver=approver)
            return Verdict.deny(f"{sub} is not carried by the proxy; use the k8s_exec tool")
        if sub == "proxy":
            return Verdict.deny("API server proxying is not carried by the proxy")
        if r.group is None:
            return Verdict(Decision.allow()) if not r.write else Verdict.deny("only reads of non-resource paths")
        if redacted and r.secret and not r.write and not r.watch:
            return Verdict(Decision.allow("values redacted"))
        if not r.privileged:
            return Verdict(Decision.allow())
        if cfg.read_only:
            return Verdict.deny(f"cluster {cfg.name} is read-only here")
        if approver:
            return Verdict(Decision.allow("approved"), impersonate=True, approver=approver)
        if r.write and r.dry_run:
            return Verdict(Decision.allow("dry run"), impersonate=True)
        if not cid or self._grants is None:
            return Verdict.deny("no conversation to hold a grant")
        if r.write:
            return await self._write(cfg, cid, r)
        return await self._secret_read(cfg, cid, r)

    async def _write(self, cfg: ClusterConfig, cid: str, r: KubeRequest) -> Verdict:
        if not r.namespace:
            return Verdict.deny("cluster-scoped writes need their own approval: use k8s_apply or k8s_delete")
        found = await self._grants.active(cid, cfg.name, r.namespace, kind="write")
        if found:
            return Verdict(Decision.allow("write grant"), impersonate=True, approver=found[0].approved_by)
        return Verdict.deny(self._no_grant(cfg, r.namespace))

    async def _secret_read(self, cfg: ClusterConfig, cid: str, r: KubeRequest) -> Verdict:
        if not r.namespace:
            return Verdict.deny("Secrets are read one namespace at a time")
        if r.name and not r.subresource:
            for g in await self._grants.active(cid, cfg.name, r.namespace, kind="secret"):
                if r.name in g.names:
                    return Verdict(Decision.allow("secret grant"), impersonate=True, approver=g.approved_by)
            return Verdict.deny(
                f"reading Secret {r.namespace}/{r.name} needs a grant: call k8s_request_secret_access"
            )
        return Verdict.deny("Secrets can't be listed or watched; read them by name under k8s_request_secret_access")

    def _no_grant(self, cfg: ClusterConfig, namespace: str) -> str:
        if not cfg.grants_enabled:
            return f"cluster {cfg.name} takes writes only through k8s_apply and the other k8s_* tools"
        return f"writes in {namespace} need a write grant: call k8s_request_grant (then retry)"


def auth_headers(token: str, impersonate: str | None, cid: str, v: Verdict) -> dict[str, str]:
    """The cluster's token, plus `Impersonate-*` when the verdict runs as the cluster's user."""
    headers = {"Authorization": token} if token else {}
    if impersonate and v.impersonate:
        headers["Impersonate-User"] = impersonate
        headers["Impersonate-Extra-scooter-conversation"] = cid
        if v.approver:
            headers["Impersonate-Extra-scooter-approver"] = v.approver
    return headers


@dataclass(frozen=True)
class _Conn:
    base: httpx.URL
    endpoint: Endpoint
    transport: httpx.AsyncBaseTransport
    ssl: ssl.SSLContext | None


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
                ep = await self._auth.endpoint()
                if self._conn and self._conn.endpoint.tls_key == ep.tls_key:
                    transport, ctx = self._conn.transport, self._conn.ssl
                elif self._inner is not None:
                    transport, ctx = self._inner, None
                else:
                    ctx = _ssl(ep)
                    transport = httpx.AsyncHTTPTransport(verify=ctx)
                self._conn = _Conn(httpx.URL(ep.server), ep, transport, ctx)
                self._built = time.monotonic()
            return self._conn

    async def token(self) -> str:
        # Read per call: inCluster's token file rotates.
        return (await self.current()).endpoint.authorization()


def _ssl(ep: Endpoint) -> ssl.SSLContext:
    ctx = ssl.create_default_context(cafile=ep.ca_file or certifi.where())
    if ep.cert_file:
        ctx.load_cert_chain(ep.cert_file, ep.key_file or None)
    if not ep.verify:
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
        if conn.endpoint.tls_server_name:
            request.extensions = {**request.extensions, "sni_hostname": conn.endpoint.tls_server_name}
        r = parse(request.method, request.url.path, request.url.query.decode("ascii", "replace"))
        if not r.helm_read:
            return await conn.transport.handle_async_request(request)
        if not r.name:
            return await conn.transport.handle_async_request(_only_helm_releases(request))
        request.headers["Accept"] = "application/json"
        resp = await conn.transport.handle_async_request(request)
        if resp.status_code != 200:
            return resp
        body = await resp.aread()
        await resp.aclose()
        if json.loads(body).get("type") != HELM_RELEASE_TYPE:
            return _forbidden(f"Secret {r.namespace}/{r.name} is not a Helm release")
        # aread() decoded the body, so its framing headers no longer apply.
        headers = [(k, v) for k, v in resp.headers.items()
                   if k.lower() not in ("content-encoding", "content-length", "transfer-encoding")]
        return httpx.Response(200, headers=headers, content=body)


def _only_helm_releases(request: httpx.Request) -> httpx.Request:
    """Narrows a Secret list to Helm's release type; field selectors are ANDed."""
    params = request.url.params
    fs = ",".join(v for v in [*params.get_list("fieldSelector"), f"type={HELM_RELEASE_TYPE}"] if v)
    request.url = request.url.copy_with(params=params.set("fieldSelector", fs))
    return request


def _forbidden(message: str) -> httpx.Response:
    return httpx.Response(403, json=status_body(403, f"denied by the Scooter forge policy: {message}"))


class KubeCredential:
    """The proxy's credential step: the token, plus `Impersonate-*` when the policy runs it as the user."""

    def __init__(self, clusters: dict[str, ClusterConfig], links: dict[str, ClusterLink],
                 policy: KubePolicy) -> None:
        self._clusters = clusters
        self._links = links
        self._policy = policy

    async def get(self, identity: Identity, request: ForgeRequest | None = None) -> Credential:
        if request is None:
            raise ValueError("a k8s credential is for one request")
        name = cluster_of(request.host)
        cid = identity.conversation_id
        v = await self._policy.evaluate(name, cid, parse(request.method, request.path, request.query))
        headers = auth_headers(await self._links[name].token(), self._clusters[name].impersonate, cid, v)
        return Credential(kind="multi-header", value=json.dumps(headers))
