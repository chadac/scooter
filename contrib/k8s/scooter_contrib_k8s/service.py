"""The k8s operations behind the tools: reads run at once; writes wait for a person.

A gated call checks itself against the cluster with a server-side dry run, then either
runs under an active grant or raises a card. Approve runs exactly the stored request.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

import yaml

from scooter_broker_lib.approvals import Approvals, ApprovalRequest, Approver, Decision, TooManyPending
from scooter_broker_lib.owner import OwnerResolver

from . import objects
from .approvals import GRANTABLE, KIND, Op, card, headline, may_approve, target
from .config import ClusterConfig
from .kube import Actor, K8sError, Kube, Resource
from .store import GrantStore

logger = logging.getLogger(__name__)

MAX_PENDING = 5
EXPIRES_AFTER = timedelta(hours=1)
MAX_MANIFESTS = 20
MAX_MANIFEST_BYTES = 256 * 1024
MAX_PREVIEW = 6000
MAX_OUTPUT = 64 * 1024
MAX_EXEC_SECONDS = 120


class Refused(Exception):
    """The call can't go ahead; the message says why, for the agent."""


@dataclass
class Cluster:
    config: ClusterConfig
    kube: Kube


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[:limit] + f"\n… ({len(text) - limit} more characters)"


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat(timespec="seconds")


def _reveal(data: dict, keys: list[str]) -> dict:
    out = {}
    for k in keys or sorted(data):
        try:
            out[k] = base64.b64decode(data[k], validate=True).decode()
        except (binascii.Error, UnicodeDecodeError, ValueError):
            out[k] = {"base64": data[k]}
    return out


class K8sService:
    def __init__(self, clusters: dict[str, Cluster], grants: GrantStore | None,
                 owners: OwnerResolver | None) -> None:
        self.clusters = clusters
        self.grants = grants
        self.owners = owners
        self.approvals: Approvals[Op] = Approvals(
            contrib="k8s", kind=KIND, payload=Op, render=card, may_approve=may_approve,
            max_pending=MAX_PENDING, expires_after=EXPIRES_AFTER,
        )
        self.approvals.on("approve")(self._approve)
        self.approvals.on("deny")(self._deny)

    # --- lookups --------------------------------------------------------------------

    def cluster(self, name: str) -> Cluster:
        if not name and len(self.clusters) == 1:
            return next(iter(self.clusters.values()))
        if name not in self.clusters:
            known = ", ".join(sorted(self.clusters)) or "none"
            raise Refused(f"no cluster {name!r}; configured: {known}" if name else f"name a cluster: {known}")
        return self.clusters[name]

    def namespace(self, c: Cluster, namespace: str) -> str:
        return namespace or c.config.default_namespace

    # --- gated requests -------------------------------------------------------------

    async def submit(self, conversation_id: str, op: Op) -> dict[str, Any]:
        """Run `op` under a grant, or raise its card; what the tool returns."""
        c = self.cluster(op.cluster)
        if c.config.read_only:
            raise Refused(f"cluster {op.cluster} is read-only here")
        if not conversation_id:
            raise Refused("no conversation for this caller")
        grant = await self._grant_for(conversation_id, op)
        if grant is not None:
            result = await self.run(op, Actor(conversation_id, grant.approved_by))
            logger.info("k8s write under grant", extra=self._audit(op, conversation_id, grant=grant.id))
            return {"status": "done", "grant_id": grant.id, "result": result}
        access = await self.owners.access(conversation_id) if self.owners else None
        owner = access.owner if access else None
        if not op.approvers and not owner:
            raise Refused("this needs the owner's approval, and this conversation has no known owner")
        try:
            req = await self.approvals.request(conversation_id, op, owner=owner or "")
        except TooManyPending as e:
            raise Refused(str(e)) from None
        return Approvals.pending_result(req)

    async def _grant_for(self, conversation_id: str, op: Op):
        if op.verb not in GRANTABLE or self.grants is None:
            return None
        if op.verb == "apply":
            if not all(m["resource"]["namespaced"] for m in op.manifests):
                return None
            spaces = {m["body"]["metadata"]["namespace"] for m in op.manifests}
        else:
            if not op.namespace:
                return None
            spaces = {op.namespace}
        if len(spaces) != 1:
            return None
        found = await self.grants.active(conversation_id, op.cluster, spaces.pop())
        return found[0] if found else None

    def _op(self, c: Cluster, verb: str, **kw) -> Op:
        return Op(cluster=c.config.name, verb=verb, approvers=list(c.config.approvers), **kw)

    async def lookup(self, c: Cluster, kind: str, name: str, namespace: str, api_version: str):
        res = await c.kube.resource(kind, api_version)
        ns = self.namespace(c, namespace) if res.namespaced else ""
        obj = await c.kube.get(res, name, ns or None)
        return res, ns, obj

    async def plan_apply(self, conversation_id: str, cluster: str, manifests: str) -> Op:
        c = self.cluster(cluster)
        if len(manifests.encode()) > MAX_MANIFEST_BYTES:
            raise Refused(f"manifests exceed {MAX_MANIFEST_BYTES} bytes")
        try:
            docs = [d for d in yaml.safe_load_all(manifests) if d]
        except yaml.YAMLError as e:
            raise Refused(f"manifests are not valid YAML: {e}") from None
        if not docs:
            raise Refused("no objects in manifests")
        if len(docs) > MAX_MANIFESTS:
            raise Refused(f"at most {MAX_MANIFESTS} objects per apply")
        actor = Actor(conversation_id)
        planned, previews = [], []
        for d in docs:
            if not isinstance(d, dict) or not d.get("apiVersion") or not d.get("kind") or not (d.get("metadata") or {}).get("name"):
                raise Refused("each object needs apiVersion, kind and metadata.name")
            res = await c.kube.resource(d["kind"], d["apiVersion"])
            meta = d["metadata"]
            if res.namespaced:
                meta["namespace"] = meta.get("namespace") or c.config.default_namespace
            else:
                meta.pop("namespace", None)
            try:
                live = await c.kube.get(res, meta["name"], meta.get("namespace"))
            except K8sError as e:
                if e.status != 404:
                    raise
                live = None
            dry = await c.kube.apply(res, d, dry_run=True, actor=actor)
            change = objects.diff(live, dry, kind=res.kind)
            state = "created" if live is None else ("changed" if change else "unchanged")
            previews.append(f"{objects.describe(d)}: {state}" + (f"\n{change}" if change else ""))
            planned.append({"resource": asdict(res), "body": d})
        preview = clip("\n\n".join(previews), MAX_PREVIEW)
        return self._op(c, "apply", manifests=planned, preview=preview)

    async def plan_delete(self, conversation_id: str, cluster: str, kind: str, name: str, namespace: str, api_version: str) -> Op:
        c = self.cluster(cluster)
        res, ns, obj = await self.lookup(c, kind, name, namespace, api_version)
        await c.kube.delete(res, name, ns or None, dry_run=True, actor=Actor(conversation_id))
        notes = ["Objects it owns are deleted with it (propagation Background)."]
        owners = (obj.get("metadata") or {}).get("ownerReferences") or []
        if owners:
            names = ", ".join(f"{o.get('kind')} {o.get('name')}" for o in owners)
            notes.append(f"It is owned by {names}, which may recreate it.")
        return self._op(c, "delete", namespace=ns, kind=res.kind, api_version=res.api_version, name=name,
                        preview=" ".join(notes))

    async def plan_scale(self, conversation_id: str, cluster: str, kind: str, name: str, replicas: int, namespace: str,
                         api_version: str) -> Op:
        if replicas < 0:
            raise Refused("replicas must be 0 or more")
        c = self.cluster(cluster)
        res, ns, obj = await self.lookup(c, kind, name, namespace, api_version)
        if "replicas" not in (obj.get("spec") or {}):
            raise Refused(f"{res.kind} {name} has no spec.replicas to scale")
        await c.kube.patch(res, name, ns or None, {"spec": {"replicas": replicas}}, dry_run=True,
                           actor=Actor(conversation_id))
        return self._op(c, "scale", namespace=ns, kind=res.kind, api_version=res.api_version, name=name,
                        replicas=replicas, preview=f"Replicas: {obj['spec']['replicas']} → {replicas}.")

    async def plan_restart(self, conversation_id: str, cluster: str, kind: str, name: str, namespace: str, api_version: str) -> Op:
        c = self.cluster(cluster)
        res, ns, obj = await self.lookup(c, kind, name, namespace, api_version)
        if "template" not in (obj.get("spec") or {}):
            raise Refused(f"{res.kind} {name} has no pod template to restart")
        await c.kube.patch(res, name, ns or None, _restart_patch(), dry_run=True, actor=Actor(conversation_id))
        return self._op(c, "restart", namespace=ns, kind=res.kind, api_version=res.api_version, name=name,
                        preview="Every pod is replaced, following its rollout strategy.")

    async def plan_exec(self, cluster: str, pod: str, command: list[str], namespace: str, container: str) -> Op:
        if not command or not all(isinstance(a, str) for a in command):
            raise Refused("command is a non-empty list of strings, the argv to run")
        c = self.cluster(cluster)
        ns = self.namespace(c, namespace)
        await c.kube.get(await c.kube.resource("Pod", "v1"), pod, ns)
        return self._op(c, "exec", namespace=ns, kind="Pod", api_version="v1", name=pod, argv=list(command),
                        container=container,
                        preview=f"Argv: {json.dumps(command)}\nIts output, up to 64 KiB, goes to the agent.")

    async def plan_reveal(self, conversation_id: str, cluster: str, name: str, keys: list[str], namespace: str) -> Op:
        c = self.cluster(cluster)
        ns = self.namespace(c, namespace)
        secret = await c.kube.get(await c.kube.resource("Secret", "v1"), name, ns, actor=Actor(conversation_id))
        missing = sorted(set(keys) - set(secret.get("data") or {}))
        if missing:
            raise Refused(f"Secret {ns}/{name} has no key {', '.join(missing)}")
        return self._op(c, "reveal", namespace=ns, kind="Secret", api_version="v1", name=name, keys=list(keys),
                        preview="The values go to the agent, and so into this conversation's transcript.")

    async def plan_grant(self, cluster: str, namespace: str, minutes: int, reason: str) -> Op:
        c = self.cluster(cluster)
        if not c.config.grants_enabled:
            raise Refused(f"cluster {c.config.name} does not allow write grants; each write is approved on its own")
        if not namespace:
            raise Refused("a grant needs a namespace")
        if not 1 <= minutes <= c.config.grant_max_minutes:
            raise Refused(f"minutes must be between 1 and {c.config.grant_max_minutes}")
        if not reason.strip():
            raise Refused("say why in `reason`; the approver reads it")
        preview = (
            f"Reason: {reason.strip()}\n\nCovers apply, delete, scale and rollout restart of namespaced objects "
            f"in {namespace}, from this conversation only. Exec, Secret reads and cluster-scoped objects still "
            "need their own approval. It starts when approved."
        )
        return self._op(c, "grant", namespace=namespace, minutes=minutes, reason=reason.strip(), preview=preview)

    # --- running what was approved --------------------------------------------------

    async def run(self, op: Op, actor: Actor) -> Any:
        """Carry out `op` for real, for `actor`; its result as the agent sees it."""
        kube = self.cluster(op.cluster).kube
        res = Resource(api_version=op.api_version, kind=op.kind, name="", namespaced=bool(op.namespace))
        ns = op.namespace or None
        match op.verb:
            case "apply":
                done = []
                for m in op.manifests:
                    out = await kube.apply(Resource(**m["resource"]), m["body"], dry_run=False, actor=actor)
                    done.append(f"{objects.describe(out)}: applied (resourceVersion "
                                f"{(out.get('metadata') or {}).get('resourceVersion')})")
                return "\n".join(done)
            case "delete":
                await kube.delete(res, op.name, ns, dry_run=False, actor=actor)
                return f"{target(op)}: deleted"
            case "scale":
                await kube.patch(res, op.name, ns, {"spec": {"replicas": op.replicas}}, dry_run=False, actor=actor)
                return f"{target(op)}: scaled to {op.replicas} replicas"
            case "restart":
                await kube.patch(res, op.name, ns, _restart_patch(), dry_run=False, actor=actor)
                return f"{target(op)}: rollout restarted"
            case "exec":
                r = await kube.exec(op.name, op.namespace, op.argv, actor=actor, container=op.container,
                                    timeout=MAX_EXEC_SECONDS, limit=MAX_OUTPUT)
                return {"exit_code": r.exit_code, "stdout": r.stdout, "stderr": r.stderr}
            case "reveal":
                secret = await kube.get(Resource(api_version="v1", kind="Secret", name="secrets", namespaced=True),
                                        op.name, op.namespace, actor=actor)
                return _reveal(secret.get("data") or {}, op.keys)
        raise Refused(f"unknown verb {op.verb!r}")

    def _audit(self, op: Op, conversation_id: str, **extra) -> dict:
        objs = [objects.describe(m["body"]) for m in op.manifests] if op.manifests else [target(op)]
        return {"cluster": op.cluster, "verb": op.verb, "objects": objs, "conversation_id": conversation_id, **extra}

    async def _approve(self, req: ApprovalRequest[Op], who: Approver) -> Decision:
        op = req.payload
        if self.cluster(op.cluster).config.read_only:
            raise Refused(f"cluster {op.cluster} became read-only")
        logger.info("k8s write approved", extra=self._audit(op, req.conversation_id, approved_by=who.id,
                                                             request_id=req.id))
        if op.verb == "grant":
            if self.grants is None:
                raise Refused("grants are not configured here")
            g = await self.grants.add(req.conversation_id, op.cluster, op.namespace, minutes=op.minutes,
                                      approved_by=who.id, request_id=req.id)
            return Decision(
                f"The user approved your grant: until {iso(g.expires_at)}, your apply, delete, scale and "
                f"rollout restart calls in namespace {op.namespace} on cluster {op.cluster} run without a card.",
                body={"grant_id": g.id},
            )
        result = await self.run(op, Actor(req.conversation_id, who.id))
        text = result if isinstance(result, str) else json.dumps(result, indent=1)
        return Decision(f"The user approved your request to {headline(op)}.\n\n{clip(text, MAX_OUTPUT)}")

    async def _deny(self, req: ApprovalRequest[Op], who: Approver) -> Decision:
        return Decision(f"The user denied your request to {headline(req.payload)}; nothing was done.")


def _restart_patch() -> dict:
    at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return {"spec": {"template": {"metadata": {"annotations": {"kubectl.kubernetes.io/restartedAt": at}}}}}
