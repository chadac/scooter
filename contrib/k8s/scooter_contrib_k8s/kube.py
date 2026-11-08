"""One cluster's API: the few calls the tools make, over the kubernetes dynamic client.

Every call is the sync client run in a thread. Kinds resolve by kind, plural, singular
or short name, so `deploy` finds apps/v1 Deployment; subresources never resolve.

Writes, exec and Secret reads take an Actor. When the cluster names an `impersonate`
user, they run as that user, with the conversation and approver as audit extras.
"""

from __future__ import annotations

import asyncio
import json
import ssl
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlencode, urlparse

import certifi
import websocket

from kubernetes import client
from kubernetes.client.rest import ApiException
from kubernetes.dynamic import DynamicClient
from kubernetes.dynamic.exceptions import DynamicApiError
from kubernetes.stream.ws_client import get_websocket_url

from .auth import ClusterAuth

FIELD_MANAGER = "scooter"
_DRY = "All"


class K8sError(Exception):
    """An API call failed; the message is fit for the agent."""

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
    """Whom a privileged call is for, as the audit log records it."""

    conversation: str
    approver: str = ""


@dataclass(frozen=True)
class ExecResult:
    stdout: str
    stderr: str
    exit_code: int | None


def _error(e: Exception) -> K8sError:
    status = getattr(e, "status", None)
    body = getattr(e, "body", None)
    message = str(getattr(e, "reason", "") or e)
    try:
        message = json.loads(body).get("message") or message
    except (TypeError, ValueError, AttributeError):
        pass
    return K8sError(f"{status} {message}" if status else message, status)


class Kube:
    """The real cluster, built lazily from its auth and rebuilt after `auth.ttl`."""

    def __init__(self, auth: ClusterAuth, impersonate: str | None = None) -> None:
        self._auth = auth
        self._impersonate = impersonate
        self._built: tuple[float, client.ApiClient, DynamicClient] | None = None
        self._lock = asyncio.Lock()

    async def _clients(self) -> tuple[client.ApiClient, DynamicClient]:
        async with self._lock:
            ttl = self._auth.ttl
            if self._built is None or (ttl is not None and time.monotonic() - self._built[0] > ttl):
                api = client.ApiClient(await self._auth.configuration())
                dyn = await asyncio.to_thread(DynamicClient, api)
                self._built = (time.monotonic(), api, dyn)
            return self._built[1], self._built[2]

    def _headers(self, actor: Actor | None) -> dict[str, str]:
        if not self._impersonate or actor is None:
            return {}
        out = {"Impersonate-User": self._impersonate, "Impersonate-Extra-scooter-conversation": actor.conversation}
        if actor.approver:
            out["Impersonate-Extra-scooter-approver"] = actor.approver
        return out

    async def _call(self, fn, *args, **kwargs) -> Any:
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except (ApiException, DynamicApiError) as e:
            raise _error(e) from None

    # --- discovery ------------------------------------------------------------------

    async def api_resources(self) -> list[Resource]:
        _, dyn = await self._clients()
        found = await self._call(dyn.resources.search)
        out = {
            (r.group_version, r.kind): Resource(
                api_version=r.group_version, kind=r.kind, name=r.name, namespaced=bool(r.namespaced),
                short_names=tuple(r.short_names or ()), verbs=tuple(r.verbs or ()),
                preferred=bool(getattr(r, "preferred", True)),
            )
            for r in found
            if getattr(r, "kind", None) and "/" not in (r.name or "") and not r.kind.endswith("List")
        }
        return sorted(out.values(), key=lambda r: (r.api_version, r.kind))

    async def resource(self, kind: str, api_version: str = "") -> Resource:
        return resolve(await self.api_resources(), kind, api_version)

    async def _dyn(self, res: Resource):
        _, dyn = await self._clients()
        return await self._call(dyn.resources.get, api_version=res.api_version, kind=res.kind)

    # --- reads ----------------------------------------------------------------------

    async def list(self, res: Resource, namespace: str | None, *, label_selector: str = "",
                   field_selector: str = "", limit: int = 0) -> list[dict]:
        r = await self._dyn(res)
        got = await self._call(
            r.get, namespace=namespace if res.namespaced else None,
            label_selector=label_selector or None, field_selector=field_selector or None, limit=limit or None,
        )
        return got.to_dict().get("items") or []

    async def get(self, res: Resource, name: str, namespace: str | None, *, actor: Actor | None = None) -> dict:
        """`actor` for reads `view` can't do, such as Secrets."""
        r = await self._dyn(res)
        got = await self._call(r.get, name=name, namespace=namespace if res.namespaced else None,
                               header_params=self._headers(actor))
        return got.to_dict()

    async def logs(self, pod: str, namespace: str, *, container: str = "", tail: int = 200,
                   since_seconds: int = 0, previous: bool = False) -> str:
        api, _ = await self._clients()
        core = client.CoreV1Api(api)
        return await self._call(
            core.read_namespaced_pod_log, pod, namespace, container=container or None, tail_lines=tail or None,
            since_seconds=since_seconds or None, previous=previous,
        )

    # --- writes ---------------------------------------------------------------------

    async def apply(self, res: Resource, body: dict, *, dry_run: bool, actor: Actor) -> dict:
        r = await self._dyn(res)
        ns = body.get("metadata", {}).get("namespace") if res.namespaced else None
        out = await self._call(
            r.server_side_apply, body=body, namespace=ns, field_manager=FIELD_MANAGER,
            force_conflicts=False, dry_run=_DRY if dry_run else None, header_params=self._headers(actor),
        )
        return out.to_dict()

    async def delete(self, res: Resource, name: str, namespace: str | None, *, dry_run: bool,
                     actor: Actor) -> None:
        r = await self._dyn(res)
        await self._call(
            r.delete, name=name, namespace=namespace if res.namespaced else None,
            propagation_policy="Background", dry_run=_DRY if dry_run else None,
            header_params=self._headers(actor),
        )

    async def patch(self, res: Resource, name: str, namespace: str | None, patch: dict, *, dry_run: bool,
                    actor: Actor) -> None:
        r = await self._dyn(res)
        await self._call(
            r.patch, body=patch, name=name, namespace=namespace if res.namespaced else None,
            content_type="application/merge-patch+json", field_manager=FIELD_MANAGER,
            dry_run=_DRY if dry_run else None, header_params=self._headers(actor),
        )

    async def exec(self, pod: str, namespace: str, argv: list[str], *, actor: Actor, container: str = "",
                   timeout: int = 60, limit: int = 64 * 1024) -> ExecResult:
        api, _ = await self._clients()
        cfg = api.configuration
        query = [("command", a) for a in argv] + [("stdout", "true"), ("stderr", "true")]
        if container:
            query.append(("container", container))
        path = f"/api/v1/namespaces/{quote(namespace, safe='')}/pods/{quote(pod, safe='')}/exec"
        url = get_websocket_url(f"{cfg.host}{path}?{urlencode(query)}")
        headers = self._headers(actor)
        auth = cfg.auth_settings().get("BearerToken")
        if auth:
            headers[auth["key"]] = auth["value"]

        def run() -> ExecResult:
            ws = _connect(cfg, url, headers)
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


def _connect(cfg: client.Configuration, url: str, headers: dict[str, str]) -> websocket.WebSocket:
    """An exec socket with our headers; kubernetes.stream drops Impersonate-*."""
    ssl_opts: dict[str, Any] = {"cert_reqs": ssl.CERT_NONE}
    if url.startswith("wss://") and cfg.verify_ssl:
        ssl_opts = {"cert_reqs": ssl.CERT_REQUIRED, "ca_certs": cfg.ssl_ca_cert or certifi.where()}
        if cfg.assert_hostname is not None:
            ssl_opts["check_hostname"] = cfg.assert_hostname
    if cfg.cert_file:
        ssl_opts["certfile"] = cfg.cert_file
    if cfg.key_file:
        ssl_opts["keyfile"] = cfg.key_file
    if cfg.tls_server_name:
        ssl_opts["server_hostname"] = cfg.tls_server_name
    opts: dict[str, Any] = {}
    if cfg.proxy:
        proxy = urlparse(cfg.proxy)
        opts = {"http_proxy_host": proxy.hostname, "http_proxy_port": proxy.port, "proxy_type": "http"}
    ws = websocket.WebSocket(sslopt=ssl_opts, skip_utf8_validation=True)
    ws.connect(url, header=[f"{k}: {v}" for k, v in headers.items()] + ["Sec-WebSocket-Protocol: v4.channel.k8s.io"],
               **opts)
    return ws


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
