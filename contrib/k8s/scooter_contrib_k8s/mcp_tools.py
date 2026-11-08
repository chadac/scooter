"""k8s' agent tools. Reads answer at once with Secret values hidden; writes, exec and
Secret reveals return `pending_approval` until a person decides, unless a grant covers them.

The conversation always comes from the verified conversation token, never an argument.
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult

from . import objects
from .approvals import Op
from .kube import K8sError
from .service import MAX_OUTPUT, K8sService, Refused, clip, iso

mcp = FastMCP(name="k8s")

# Set by the provider factory.
_service: K8sService | None = None


def configure(service: K8sService | None) -> None:
    global _service
    _service = service


def _svc() -> K8sService:
    if _service is None:
        raise Refused("k8s is not configured here")
    return _service


async def _answer(work: Awaitable[Any]) -> ToolResult:
    try:
        out = await work
    except (Refused, K8sError) as e:
        return ToolResult.error(str(e))
    return ToolResult.ok(out if isinstance(out, str) else json.dumps(out, indent=1, default=str))


async def _gated(ctx: ToolContext, plan: Callable[[K8sService, str], Awaitable[Op]]) -> Any:
    svc = _svc()
    cid = ctx.identity.conversation_id
    return await svc.submit(cid, await plan(svc, cid))


@mcp.tool
async def k8s_clusters() -> ToolResult:
    """The clusters you can reach: each one's default namespace, whether it is read-only,
    whether it allows write grants, who approves its requests (empty: the conversation's owner),
    and the Kubernetes user writes run as (null: the broker's own)."""
    async def run():
        return [
            {"cluster": c.config.name, "default_namespace": c.config.default_namespace,
             "read_only": c.config.read_only, "grants": c.config.grants_enabled,
             "grant_max_minutes": c.config.grant_max_minutes if c.config.grants_enabled else None,
             "approvers": list(c.config.approvers), "writes_as": c.config.impersonate}
            for c in _svc().clusters.values()
        ]
    return await _answer(run())


@mcp.tool
async def k8s_api_resources(cluster: str = "", search: str = "") -> ToolResult:
    """Kinds the cluster serves, with api_version, plural name, short names and whether each
    is namespaced. `search` filters by a substring of the kind or name. `cluster` may be
    empty when only one is configured."""
    async def run():
        c = _svc().cluster(cluster)
        q = search.lower()
        return [
            {"api_version": r.api_version, "kind": r.kind, "name": r.name, "short_names": list(r.short_names),
             "namespaced": r.namespaced}
            for r in await c.kube.api_resources()
            if r.preferred and (not q or q in r.kind.lower() or q in r.name.lower())
        ]
    return await _answer(run())


@mcp.tool
async def k8s_list(
    kind: str, cluster: str = "", namespace: str = "", all_namespaces: bool = False,
    label_selector: str = "", field_selector: str = "", limit: int = 200, api_version: str = "",
) -> ToolResult:
    """List objects of a kind (`pods`, `deploy`, `Ingress`, ...) as compact rows: name,
    namespace, created and a status summary. Use k8s_get for one object in full. Secrets list
    their key names only. `namespace` defaults to the cluster's; `all_namespaces` lists every one."""
    async def run():
        svc = _svc()
        c = svc.cluster(cluster)
        res = await c.kube.resource(kind, api_version)
        ns = None if all_namespaces or not res.namespaced else svc.namespace(c, namespace)
        items = await c.kube.list(res, ns, label_selector=label_selector, field_selector=field_selector,
                                  limit=max(1, min(limit, 1000)))
        rows = [objects.summary(i, res.kind) for i in items]
        return rows if rows else f"No {res.name} found."
    return await _answer(run())


@mcp.tool
async def k8s_get(kind: str, name: str, cluster: str = "", namespace: str = "", api_version: str = "") -> ToolResult:
    """One object as YAML, managedFields stripped. A Secret shows its keys and value lengths,
    never the values: ask with k8s_secret_reveal."""
    async def run():
        svc = _svc()
        c = svc.cluster(cluster)
        res, _, obj = await svc.lookup(c, kind, name, namespace, api_version)
        return objects.to_yaml(objects.clean(obj, kind=res.kind))
    return await _answer(run())


async def _events(c, namespace: str | None, kind: str = "", name: str = "", limit: int = 50) -> list[dict]:
    res = await c.kube.resource("Event", "v1")
    selector = ",".join(s for s in (f"involvedObject.kind={kind}" if kind else "",
                                     f"involvedObject.name={name}" if name else "") if s)
    items = await c.kube.list(res, namespace, field_selector=selector)
    rows = sorted(map(objects.event, items), key=lambda e: str(e["last_seen"] or ""), reverse=True)
    return rows[:limit]


@mcp.tool
async def k8s_describe(kind: str, name: str, cluster: str = "", namespace: str = "", api_version: str = "") -> ToolResult:
    """One object plus its recent Events, like `kubectl describe`."""
    async def run():
        svc = _svc()
        c = svc.cluster(cluster)
        res, ns, obj = await svc.lookup(c, kind, name, namespace, api_version)
        events = await _events(c, ns or None, res.kind, name, 20)
        return objects.to_yaml({"object": objects.clean(obj, kind=res.kind), "events": events})
    return await _answer(run())


@mcp.tool
async def k8s_events(cluster: str = "", namespace: str = "", kind: str = "", name: str = "",
                     all_namespaces: bool = False, limit: int = 50) -> ToolResult:
    """Events, newest first, for a namespace or, given `kind` and `name`, one object."""
    async def run():
        svc = _svc()
        c = svc.cluster(cluster)
        ns = None if all_namespaces else svc.namespace(c, namespace)
        return await _events(c, ns, kind, name, max(1, min(limit, 500))) or "No events."
    return await _answer(run())


@mcp.tool
async def k8s_logs(pod: str, cluster: str = "", namespace: str = "", container: str = "", tail: int = 200,
                   since_seconds: int = 0, previous: bool = False) -> ToolResult:
    """A pod's logs: the last `tail` lines (at most 2000), optionally only the last
    `since_seconds`, or the previous container's with `previous`. Capped at 64 KiB."""
    async def run():
        svc = _svc()
        c = svc.cluster(cluster)
        text = await c.kube.logs(pod, svc.namespace(c, namespace), container=container,
                                 tail=max(1, min(tail, 2000)), since_seconds=max(0, since_seconds), previous=previous)
        return clip(text, MAX_OUTPUT) or "(no output)"
    return await _answer(run())


@mcp.tool
async def k8s_secret_reveal(name: str, keys: list[str] | None = None, cluster: str = "", namespace: str = "",
                            ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Ask a person to show you a Secret's values: `keys` names which (empty: all). Always
    needs approval; the values come back in a message and land in the transcript, so ask
    only for the keys you need."""
    return await _answer(_gated(ctx, lambda s, cid: s.plan_reveal(cid, cluster, name, keys or [], namespace)))


@mcp.tool
async def k8s_apply(manifests: str, cluster: str = "", ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Server-side apply YAML (one or more `---` documents, at most 20 objects). A dry run
    checks it first: errors come back at once, and the approver sees the diff. Objects
    without a namespace get the cluster's default. Render Helm or Kustomize yourself first."""
    return await _answer(_gated(ctx, lambda s, cid: s.plan_apply(cid, cluster, manifests)))


@mcp.tool
async def k8s_delete(kind: str, name: str, cluster: str = "", namespace: str = "", api_version: str = "",
                     ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Delete one object; what it owns goes with it."""
    return await _answer(_gated(ctx, lambda s, cid: s.plan_delete(cid, cluster, kind, name, namespace, api_version)))


@mcp.tool
async def k8s_scale(kind: str, name: str, replicas: int, cluster: str = "", namespace: str = "",
                    api_version: str = "", ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Set spec.replicas on a Deployment, StatefulSet or ReplicaSet."""
    return await _answer(_gated(ctx, lambda s, cid: s.plan_scale(cid, cluster, kind, name, replicas, namespace, api_version)))


@mcp.tool
async def k8s_rollout_restart(kind: str, name: str, cluster: str = "", namespace: str = "", api_version: str = "",
                              ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Restart a Deployment, StatefulSet or DaemonSet's pods, like `kubectl rollout restart`."""
    return await _answer(_gated(ctx, lambda s, cid: s.plan_restart(cid, cluster, kind, name, namespace, api_version)))


@mcp.tool
async def k8s_exec(pod: str, command: list[str], cluster: str = "", namespace: str = "", container: str = "",
                   ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Run one command in a pod: `command` is the argv, e.g. ["sh", "-c", "ls /data"]. No TTY
    or stdin; it is stopped after 120s and its output capped at 64 KiB. Always needs its
    own approval, even under a grant; the approver sees the exact argv."""
    return await _answer(_gated(ctx, lambda s, _: s.plan_exec(cluster, pod, command, namespace, container)))


@mcp.tool
async def k8s_request_grant(namespace: str, minutes: int, reason: str, cluster: str = "",
                            ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Ask for write access to one namespace for `minutes`, so a run of apply, delete, scale
    and rollout restart calls there needs no card each. Only on clusters that allow grants
    (k8s_clusters); ask only when you expect several changes. Exec, Secret reveals and
    cluster-scoped objects still need their own approval."""
    return await _answer(_gated(ctx, lambda s, _: s.plan_grant(cluster, namespace, minutes, reason)))


@mcp.tool
async def k8s_grants(cluster: str = "", ctx: ToolContext = ToolContextDep) -> ToolResult:
    """This conversation's active write grants and when each expires."""
    async def run():
        svc = _svc()
        if svc.grants is None:
            return "No grants."
        found = await svc.grants.active(ctx.identity.conversation_id, cluster or None)
        return [{"grant_id": g.id, "cluster": g.cluster, "namespace": g.namespace,
                 "expires_at": iso(g.expires_at), "approved_by": g.approved_by} for g in found] or "No active grants."
    return await _answer(run())
