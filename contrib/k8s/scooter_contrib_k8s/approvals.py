"""The request a person approves: one gated operation, its card and who may approve it.

Requests, routes at /k8s/approvals and cards are scooter_broker_lib.approvals; this is
the payload and its prose. The verbs live in ./service.py, which runs what was approved.
"""

from __future__ import annotations

import shlex
from dataclasses import asdict, dataclass, field

from scooter_broker_lib.approvals import ApprovalRequest, Approver, Card

KIND = "k8s.request"
# Grant-covered verbs; exec and reveal read Secrets, so excluded.
GRANTABLE = frozenset({"apply", "delete", "scale", "restart"})


@dataclass(frozen=True)
class Op:
    cluster: str
    # apply | delete | scale | restart | exec | reveal | grant
    verb: str
    namespace: str = ""
    kind: str = ""
    api_version: str = ""
    name: str = ""
    #: apply: [{resource, body}], each already dry-run checked.
    manifests: list[dict] = field(default_factory=list)
    replicas: int | None = None
    argv: list[str] = field(default_factory=list)
    container: str = ""
    keys: list[str] = field(default_factory=list)
    minutes: int = 0
    reason: str = ""
    #: The card's diff or plan, computed at request time.
    preview: str = ""
    #: Fixed at request time; config changes can't reassign deciders.
    approvers: list[str] = field(default_factory=list)


def target(op: Op) -> str:
    where = f"{op.namespace}/" if op.namespace else ""
    return f"{op.kind} {where}{op.name}"


def headline(op: Op) -> str:
    """What the agent asked for, as one clause."""
    on = f"on cluster {op.cluster}"
    match op.verb:
        case "apply":
            n = len(op.manifests)
            return f"apply {n} object{'s' if n != 1 else ''} {on}"
        case "delete":
            return f"delete {target(op)} {on}"
        case "scale":
            return f"scale {target(op)} to {op.replicas} replicas {on}"
        case "restart":
            return f"restart the rollout of {target(op)} {on}"
        case "exec":
            box = f", container {op.container}" if op.container else ""
            return f"run `{shlex.join(op.argv)}` in pod {op.namespace}/{op.name}{box} {on}"
        case "reveal":
            keys = ", ".join(op.keys) if op.keys else "every key"
            return f"read the values of Secret {op.namespace}/{op.name} ({keys}) {on}"
        case "grant":
            return f"write to namespace {op.namespace} {on} for {op.minutes} minutes without asking per change"
    return f"{op.verb} {target(op)} {on}"


def card(req: ApprovalRequest[Op]) -> Card:
    op = req.payload
    message = f"The agent wants to {headline(op)}."
    if op.preview:
        message += f"\n\n{op.preview}"
    if op.approvers:
        message += f"\n\nApprovers for {op.cluster}: {', '.join(op.approvers)}."
    # Manifests may hold Secret values; the message carries the preview.
    data = {k: v for k, v in asdict(op).items() if k not in ("manifests", "preview")}
    return Card(message=message, data=data)


def may_approve(req: ApprovalRequest[Op], who: Approver) -> bool:
    """A listed approver when the cluster names any, else the conversation's owner."""
    approvers = req.payload.approvers
    if approvers:
        return who.id in approvers or bool(who.email and who.email in approvers)
    return bool(req.owner) and req.owner == who.id
