"""One cluster's API: the few calls the tools make, over the kubernetes dynamic client.

Every call is the sync client run in a thread. Kinds resolve by kind, plural, singular
or short name, so `deploy` finds apps/v1 Deployment; subresources never resolve.
"""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any

from kubernetes import client
from kubernetes.client.rest import ApiException
from kubernetes.dynamic import DynamicClient
from kubernetes.dynamic.exceptions import DynamicApiError
from kubernetes.stream import stream

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

    def __init__(self, auth: ClusterAuth) -> None:
        self._auth = auth
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

    async def get(self, res: Resource, name: str, namespace: str | None) -> dict:
        r = await self._dyn(res)
        return (await self._call(r.get, name=name, namespace=namespace if res.namespaced else None)).to_dict()

    async def logs(self, pod: str, namespace: str, *, container: str = "", tail: int = 200,
                   since_seconds: int = 0, previous: bool = False) -> str:
        api, _ = await self._clients()
        core = client.CoreV1Api(api)
        return await self._call(
            core.read_namespaced_pod_log, pod, namespace, container=container or None, tail_lines=tail or None,
            since_seconds=since_seconds or None, previous=previous,
        )

    # --- writes ---------------------------------------------------------------------

    async def apply(self, res: Resource, body: dict, *, dry_run: bool) -> dict:
        r = await self._dyn(res)
        ns = body.get("metadata", {}).get("namespace") if res.namespaced else None
        out = await self._call(
            r.server_side_apply, body=body, namespace=ns, field_manager=FIELD_MANAGER,
            force_conflicts=False, dry_run=_DRY if dry_run else None,
        )
        return out.to_dict()

    async def delete(self, res: Resource, name: str, namespace: str | None, *, dry_run: bool) -> None:
        r = await self._dyn(res)
        await self._call(
            r.delete, name=name, namespace=namespace if res.namespaced else None,
            propagation_policy="Background", dry_run=_DRY if dry_run else None,
        )

    async def patch(self, res: Resource, name: str, namespace: str | None, patch: dict, *, dry_run: bool) -> None:
        r = await self._dyn(res)
        await self._call(
            r.patch, body=patch, name=name, namespace=namespace if res.namespaced else None,
            content_type="application/merge-patch+json", field_manager=FIELD_MANAGER,
            dry_run=_DRY if dry_run else None,
        )

    async def exec(self, pod: str, namespace: str, argv: list[str], *, container: str = "",
                   timeout: int = 60, limit: int = 64 * 1024) -> ExecResult:
        # stream() patches its client, so exec uses a fresh one.
        api = client.ApiClient((await self._clients())[0].configuration)
        core = client.CoreV1Api(api)

        def run() -> ExecResult:
            ws = stream(
                core.connect_get_namespaced_pod_exec, pod, namespace, command=argv,
                container=container or None, stdin=False, stdout=True, stderr=True, tty=False,
                _preload_content=False,
            )
            out, err = [], []
            deadline = time.monotonic() + timeout
            try:
                while ws.is_open() and time.monotonic() < deadline:
                    ws.update(timeout=1)
                    if ws.peek_stdout():
                        out.append(ws.read_stdout())
                    if ws.peek_stderr():
                        err.append(ws.read_stderr())
                timed_out = ws.is_open()
            finally:
                ws.close()
            code = None if timed_out else ws.returncode
            stderr = "".join(err)[:limit] + (f"\n[timed out after {timeout}s]" if timed_out else "")
            return ExecResult(stdout="".join(out)[:limit], stderr=stderr, exit_code=code)

        try:
            return await self._call(run)
        finally:
            api.close()


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
