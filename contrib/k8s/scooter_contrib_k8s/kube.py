"""One cluster's API: the few calls the tools make, through KubeGateway.

The gateway does what the forge proxy does for kubectl: it classifies the request,
checks it against KubePolicy and adds the credential, so both paths obey one policy.
Kinds resolve by kind, plural, singular or short name, so `deploy` finds apps/v1
Deployment; subresources never resolve.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode

import httpx
import websocket

from .config import ClusterConfig
from .forge import ClusterLink, KubePolicy, KubeTransport, auth_headers, host_for, parse

logger = logging.getLogger(__name__)

FIELD_MANAGER = "scooter"
_DRY = "All"
DISCOVERY_TTL = 300
# Aggregated discovery (Kubernetes 1.26+) answers each root in one request.
_AGGREGATED = ("application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList,"
               "application/json;g=apidiscovery.k8s.io;v=v2beta1;as=APIGroupDiscoveryList,application/json")


class K8sError(Exception):
    """An API call failed or was refused; the message is fit for the agent."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class Resource:
    api_version: str
    kind: str
    name: str
    namespaced: bool
    short_names: tuple[str, ...] = ()
    verbs: tuple[str, ...] = ()
    #: The group's preferred version, which a bare kind resolves to.
    preferred: bool = True


@dataclass(frozen=True)
class Actor:
    """The conversation a call is for and, once a person approved its card, who did.

    `approver` lets KubePolicy allow what only a card can (exec, cluster-scoped writes),
    so set it only for the exact request that was approved. Calls under a grant leave it
    empty: the policy finds the grant itself.
    """

    conversation: str
    approver: str = ""


@dataclass(frozen=True)
class ExecResult:
    stdout: str
    stderr: str
    exit_code: int | None


def _error(resp: httpx.Response) -> K8sError:
    message = resp.reason_phrase
    try:
        message = resp.json().get("message") or message
    except (ValueError, AttributeError):
        pass
    return K8sError(f"{resp.status_code} {message}", resp.status_code)


class KubeGateway:
    """The tools' path to every cluster: classify, enforce KubePolicy, add the credential."""

    def __init__(self, clusters: dict[str, ClusterConfig], links: dict[str, ClusterLink],
                 policy: KubePolicy) -> None:
        self._clusters = clusters
        self._links = links
        self._policy = policy
        self._http = {
            name: httpx.AsyncClient(transport=KubeTransport(link), base_url=f"https://{host_for(name)}",
                                    timeout=httpx.Timeout(30, read=120))
            for name, link in links.items()
        }

    async def _authorize(self, cluster: str, method: str, path: str, query: str, actor: Actor | None,
                         redacted: bool) -> dict[str, str]:
        cid, approver = (actor.conversation, actor.approver) if actor else ("", "")
        v = await self._policy.evaluate(cluster, cid, parse(method, path, query), approver=approver,
                                        redacted=redacted)
        if not v.decision.allowed:
            raise K8sError(f"403 denied by the Scooter forge policy: {v.decision.reason}", 403)
        return auth_headers(await self._links[cluster].token(), self._clusters[cluster].impersonate, cid, v)

    async def request(self, cluster: str, method: str, path: str, *, actor: Actor | None = None,
                      params: dict | None = None, body: Any = None, content_type: str = "application/json",
                      accept: str = "application/json", redacted: bool = False) -> httpx.Response:
        params = {k: v for k, v in (params or {}).items() if v not in (None, "")}
        headers = await self._authorize(cluster, method, path, urlencode(params), actor, redacted)
        headers["Accept"] = accept
        content = None
        if body is not None:
            content = json.dumps(body).encode()
            headers["Content-Type"] = content_type
        resp = await self._http[cluster].request(method, path, params=params, content=content, headers=headers)
        if resp.status_code >= 400:
            raise _error(resp)
        return resp

    async def stream(self, cluster: str, path: str, query: list[tuple[str, str]], *, actor: Actor):
        """The URL, headers and TLS for a websocket to `path`, once the policy allows it."""
        q = urlencode(query)
        headers = await self._authorize(cluster, "GET", path, q, actor, False)
        conn = await self._links[cluster].current()
        base = conn.base
        scheme = "wss" if base.scheme == "https" else "ws"
        url = f"{scheme}://{base.netloc.decode('ascii')}{base.raw_path.decode('ascii').rstrip('/')}{path}?{q}"
        sslopt: dict[str, Any] = {"context": conn.ssl} if conn.ssl else {}
        if conn.endpoint.tls_server_name:
            sslopt["server_hostname"] = conn.endpoint.tls_server_name
        return url, headers, sslopt

    async def aclose(self) -> None:
        for c in self._http.values():
            await c.aclose()


def _path(res: Resource, namespace: str | None, name: str = "", sub: str = "") -> str:
    out = f"/apis/{res.api_version}" if "/" in res.api_version else f"/api/{res.api_version}"
    if res.namespaced and namespace:
        out += f"/namespaces/{quote(namespace, safe='')}"
    out += f"/{res.name}"
    if name:
        out += f"/{quote(name, safe='')}"
    return out + (f"/{sub}" if sub else "")


def _from_aggregated(items: list[dict]) -> list[Resource]:
    out = []
    for g in items:
        group = (g.get("metadata") or {}).get("name") or ""
        for i, v in enumerate(g.get("versions") or []):
            gv = f"{group}/{v['version']}" if group else v["version"]
            for r in v.get("resources") or []:
                kind = (r.get("responseKind") or {}).get("kind") or ""
                out.append(Resource(api_version=gv, kind=kind, name=r.get("resource") or "",
                                    namespaced=r.get("scope") == "Namespaced",
                                    short_names=tuple(r.get("shortNames") or ()), verbs=tuple(r.get("verbs") or ()),
                                    preferred=i == 0))
    return out


def _from_list(doc: dict, preferred: bool) -> list[Resource]:
    gv = doc.get("groupVersion") or ""
    return [
        Resource(api_version=gv, kind=r.get("kind") or "", name=r.get("name") or "",
                 namespaced=bool(r.get("namespaced")), short_names=tuple(r.get("shortNames") or ()),
                 verbs=tuple(r.get("verbs") or ()), preferred=preferred)
        for r in doc.get("resources") or []
    ]


class Kube:
    """One cluster, as the tools use it."""

    def __init__(self, gateway: KubeGateway, cluster: str) -> None:
        self._gw = gateway
        self._cluster = cluster
        self._found: tuple[float, list[Resource]] | None = None
        self._lock = asyncio.Lock()

    async def _call(self, method: str, path: str, **kw) -> httpx.Response:
        return await self._gw.request(self._cluster, method, path, **kw)

    async def _json(self, method: str, path: str, **kw) -> dict:
        return (await self._call(method, path, **kw)).json()

    # --- discovery ------------------------------------------------------------------

    async def api_resources(self) -> list[Resource]:
        async with self._lock:
            if self._found is None or time.monotonic() - self._found[0] > DISCOVERY_TTL:
                self._found = (time.monotonic(), await self._discover())
            found = self._found[1]
        out = {
            (r.api_version, r.kind): r for r in found
            if r.kind and "/" not in r.name and not r.kind.endswith("List")
        }
        return sorted(out.values(), key=lambda r: (r.api_version, r.kind))

    async def _discover(self) -> list[Resource]:
        core, apis = await asyncio.gather(self._json("GET", "/api", accept=_AGGREGATED),
                                          self._json("GET", "/apis", accept=_AGGREGATED))
        if core.get("kind") == apis.get("kind") == "APIGroupDiscoveryList":
            return _from_aggregated(core.get("items") or []) + _from_aggregated(apis.get("items") or [])
        wanted = [(f"/api/{v}", True) for v in core.get("versions") or []]
        for g in apis.get("groups") or []:
            pref = (g.get("preferredVersion") or {}).get("groupVersion")
            wanted += [(f"/apis/{v['groupVersion']}", v["groupVersion"] == pref) for v in g.get("versions") or []]
        docs = await asyncio.gather(*(self._json("GET", p) for p, _ in wanted), return_exceptions=True)
        out = []
        for (p, preferred), doc in zip(wanted, docs):
            if isinstance(doc, K8sError):
                # A down aggregated API (metrics, say) hides only itself.
                logger.warning("k8s discovery skipped a group", extra={"cluster": self._cluster, "path": p,
                                                                       "error": str(doc)})
                continue
            if isinstance(doc, BaseException):
                raise doc
            out += _from_list(doc, preferred)
        return out

    async def resource(self, kind: str, api_version: str = "") -> Resource:
        return resolve(await self.api_resources(), kind, api_version)

    # --- reads ----------------------------------------------------------------------

    async def list(self, res: Resource, namespace: str | None, *, label_selector: str = "",
                   field_selector: str = "", limit: int = 0, actor: Actor | None = None,
                   redacted: bool = False) -> list[dict]:
        """`redacted`: the caller hides Secret values, so the policy lets Secrets list."""
        got = await self._json("GET", _path(res, namespace), actor=actor, redacted=redacted, params={
            "labelSelector": label_selector, "fieldSelector": field_selector, "limit": limit or None,
        })
        return got.get("items") or []

    async def get(self, res: Resource, name: str, namespace: str | None, *, actor: Actor | None = None,
                  redacted: bool = False) -> dict:
        """`actor` for a Secret read a grant or card covers; `redacted` when the caller hides values."""
        return await self._json("GET", _path(res, namespace, name), actor=actor, redacted=redacted)

    async def logs(self, pod: str, namespace: str, *, container: str = "", tail: int = 200,
                   since_seconds: int = 0, previous: bool = False) -> str:
        res = Resource("v1", "Pod", "pods", True)
        r = await self._call("GET", _path(res, namespace, pod, "log"), accept="*/*", params={
            "container": container, "tailLines": tail or None, "sinceSeconds": since_seconds or None,
            "previous": "true" if previous else None,
        })
        return r.text

    # --- writes ---------------------------------------------------------------------

    async def apply(self, res: Resource, body: dict, *, dry_run: bool, actor: Actor) -> dict:
        meta = body.get("metadata") or {}
        ns = meta.get("namespace") if res.namespaced else None
        return await self._json(
            "PATCH", _path(res, ns, meta.get("name") or ""), actor=actor, body=body,
            content_type="application/apply-patch+yaml",
            params={"fieldManager": FIELD_MANAGER, "force": "false", "dryRun": _DRY if dry_run else None},
        )

    async def delete(self, res: Resource, name: str, namespace: str | None, *, dry_run: bool,
                     actor: Actor) -> None:
        await self._call("DELETE", _path(res, namespace, name), actor=actor,
                         body={"kind": "DeleteOptions", "apiVersion": "v1", "propagationPolicy": "Background"},
                         params={"dryRun": _DRY if dry_run else None})

    async def patch(self, res: Resource, name: str, namespace: str | None, patch: dict, *, dry_run: bool,
                    actor: Actor) -> None:
        await self._call("PATCH", _path(res, namespace, name), actor=actor, body=patch,
                         content_type="application/merge-patch+json",
                         params={"fieldManager": FIELD_MANAGER, "dryRun": _DRY if dry_run else None})

    async def exec(self, pod: str, namespace: str, argv: list[str], *, actor: Actor, container: str = "",
                   timeout: int = 60, limit: int = 64 * 1024) -> ExecResult:
        query = [("command", a) for a in argv] + [("stdout", "true"), ("stderr", "true")]
        if container:
            query.append(("container", container))
        path = _path(Resource("v1", "Pod", "pods", True), namespace, pod, "exec")
        url, headers, sslopt = await self._gw.stream(self._cluster, path, query, actor=actor)

        def run() -> ExecResult:
            ws = websocket.WebSocket(sslopt=sslopt, skip_utf8_validation=True)
            ws.connect(url, header=[f"{k}: {v}" for k, v in headers.items()]
                       + ["Sec-WebSocket-Protocol: v4.channel.k8s.io"])
            out, err, status, closed = bytearray(), bytearray(), None, False
            deadline = time.monotonic() + timeout
            try:
                while not closed and (left := deadline - time.monotonic()) > 0:
                    ws.settimeout(min(left, 1))
                    try:
                        op, data = ws.recv_data()
                    except websocket.WebSocketTimeoutException:
                        continue
                    except websocket.WebSocketConnectionClosedException:
                        closed = True
                        continue
                    if op == websocket.ABNF.OPCODE_CLOSE:
                        closed = True
                    elif data:
                        channel, body = data[0], data[1:]
                        if channel == 1 and len(out) < limit:
                            out += body
                        elif channel == 2 and len(err) < limit:
                            err += body
                        elif channel == 3:
                            status = body
            finally:
                ws.close()
            timed_out = not closed
            stderr = err[:limit].decode(errors="replace") + (f"\n[timed out after {timeout}s]" if timed_out else "")
            code = None if timed_out else _exit_code(status)
            return ExecResult(stdout=out[:limit].decode(errors="replace"), stderr=stderr, exit_code=code)

        try:
            return await asyncio.to_thread(run)
        except websocket.WebSocketBadStatusException as e:
            raise K8sError(f"{e.status_code} exec refused: {e.resp_body.decode(errors='replace') if e.resp_body else e}",
                           e.status_code) from None
        except (websocket.WebSocketException, OSError) as e:
            raise K8sError(f"exec failed: {e}") from None


def _exit_code(status: bytes | None) -> int | None:
    """The exit code from the v4 error channel's Status."""
    if status is None:
        return None
    try:
        doc = json.loads(status)
    except ValueError:
        return None
    if doc.get("status") == "Success":
        return 0
    for cause in (doc.get("details") or {}).get("causes") or []:
        if cause.get("reason") == "ExitCode":
            try:
                return int(cause.get("message"))
            except (TypeError, ValueError):
                return None
    return None


def resolve(resources: list[Resource], kind: str, api_version: str = "") -> Resource:
    """The one resource `kind` names; the core group wins a tie, else K8sError."""
    want = kind.strip().lower()
    hits = [
        r for r in resources
        if (not api_version or r.api_version == api_version)
        and (api_version or r.preferred)
        and want in (r.kind.lower(), r.name.lower(), *(s.lower() for s in r.short_names))
    ]
    groups = {r.api_version.rpartition("/")[0] for r in hits}
    if not hits:
        raise K8sError(f"no resource kind {kind!r}{f' in {api_version}' if api_version else ''}; see k8s_api_resources", 404)
    if len(groups) > 1:
        core = [r for r in hits if "/" not in r.api_version]
        if core:
            return core[0]
        raise K8sError(
            f"{kind!r} is ambiguous: " + ", ".join(sorted({f'{r.api_version} {r.kind}' for r in hits}))
            + "; pass api_version", 400,
        )
    return hits[0]
