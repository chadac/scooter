"""The pure reconcile core: decides what to do with one Conversation given the current
agent-host pods and their load, with no k8s and no I/O.

A Conversation is pinned to exactly one ready agent-host pod (the row's `host_pod`), chosen
least-loaded under a per-pod cap; it is reassigned with a bumped fence `host_generation` when
its pod is gone or NotReady, and left Pending when no pod can take it. A subagent
(`parent_id` set) is pinned to its parent's pod, bypassing the cap, and stays Pending
until the parent is on a ready pod.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Pod:
    name: str
    ready: bool
    ip: str | None = None      # status.podIP, the routing address the revive push dials
    deletion_cost: int | None = None  # the pod's current pod-deletion-cost annotation, None when unset
    terminating: bool = False  # metadata.deletionTimestamp is set, though the pod may still report Ready


@dataclass(frozen=True)
class ConversationState:
    """The bits of a conversations row the decision depends on."""

    name: str
    host_pod: str | None       # host_pod, the owner pod name used as the fencing identity
    phase: str                 # phase, defaulting to "Pending"
    generation: int            # host_generation, the fence epoch
    host_ip: str | None = None # the owner pod's IP, looked up from host_pod
    creator_pod: str | None = None  # creator_pod, where the conversation physically runs
    parent_id: str | None = None  # parent_id, so a subagent co-locates on its parent's pod
    phase_present: bool = True  # False when the row carries no phase yet
    sandbox_mode: str | None = None  # the backing Sandbox's spec.operatingMode, or None when it does not exist
    sandbox_ref: str | None = None  # sandbox_ref, the Sandbox object SuspendSandbox patches


# --- Actions the shell will apply -----------------------------------------

@dataclass(frozen=True)
class NoOp:
    reason: str


@dataclass(frozen=True)
class Assign:
    host_pod: str              # owner pod name, the fencing identity
    generation: int            # the new generation to write
    phase: str = "Assigned"
    host_ip: str | None = None # the chosen pod's status.podIP, the routing address


@dataclass(frozen=True)
class LeavePending:
    """No ready pod under cap can take it, so record Pending with no host."""
    reason: str


@dataclass(frozen=True)
class Detach:
    """Release a suspended conversation's placement (host_pod), leaving the phase to the agent-host."""
    reason: str


@dataclass(frozen=True)
class MarkSuspended:
    """The Sandbox is Suspended but the phase is not: force the phase to Suspended and release placement, since the Sandbox is the source of truth for alive/suspended."""
    reason: str


@dataclass
class SuspendSandbox:
    """The zombie repair: the conversation is Suspended with placement released, yet the Sandbox is Running and no host will ever sweep it again, so the loop re-suspends it after confirming over two ticks."""
    reason: str


Action = NoOp | Assign | LeavePending | Detach | MarkSuspended | SuspendSandbox


def pick_host(pods: list[Pod], load: dict[str, int], cap: int) -> str | None:
    """The least-loaded ready pod strictly under `cap` (ties broken by name for stability), or None."""
    candidates = [p for p in pods if p.ready and load.get(p.name, 0) < cap]
    if not candidates:
        return None
    return min(candidates, key=lambda p: (load.get(p.name, 0), p.name)).name


def reconcile(
    conv: ConversationState,
    pods: list[Pod],
    load: dict[str, int],
    cap: int,
    hosts: dict[str, str | None] | None = None,
) -> Action:
    """Decide the action for one Conversation, where `load` counts current assignments per pod and `hosts` maps conversation name to host_pod for subagent co-location."""
    hosts = hosts or {}
    ready_names = {p.name for p in pods if p.ready}
    ip_of = {p.name: p.ip for p in pods}

    # Failed is terminal: never reassign it or re-flag it as a zombie.
    if conv.phase == "Failed":
        return NoOp(reason="failed — terminal, no action")

    # Drift repair fires only on an existing suspended Sandbox; an absent one may be being born.
    if conv.phase != "Suspended" and conv.sandbox_mode == "Suspended":
        return MarkSuspended(
            reason=f"phase={conv.phase} but sandbox is Suspended — reconciling phase to the sandbox"
        )

    # A suspended conversation is never reassigned, and any stale placement is released.
    if conv.phase == "Suspended":
        if conv.host_pod is not None:
            return Detach(reason="suspended — release placement (clear host_pod)")
        # A subagent shares its parent's Sandbox, which stays Running while the parent lives, so
        # only the owning (top-level) row can evidence a zombie.
        if conv.sandbox_mode == "Running" and conv.parent_id is None:
            return SuspendSandbox(
                reason="suspended + unhosted but the Sandbox is RUNNING — zombie (or a revive mid-flight; loop confirms over two ticks)"
            )
        return NoOp(reason="suspended — no placement to release")

    # A subagent is pinned to its parent's pod, and the cap does not apply.
    if conv.parent_id is not None:
        parent_host = hosts.get(conv.parent_id)
        if conv.host_pod is not None and conv.host_pod == parent_host and parent_host in ready_names:
            return NoOp(reason=f"co-located with parent on {parent_host}")
        if parent_host is None or parent_host not in ready_names:
            return LeavePending(reason=f"parent {conv.parent_id} not on a ready pod yet")
        return Assign(host_pod=parent_host, generation=conv.generation + 1, host_ip=ip_of.get(parent_host))

    if conv.host_pod is not None and conv.host_pod in ready_names:
        return NoOp(reason=f"host {conv.host_pod} still ready")

    # The run physically lives on the creator pod, so prefer it and bypass the cap.
    if conv.creator_pod is not None and conv.creator_pod in ready_names:
        return Assign(
            host_pod=conv.creator_pod,
            generation=conv.generation + 1,
            host_ip=ip_of.get(conv.creator_pod),
        )

    host = pick_host(pods, load, cap)
    if host is None:
        return LeavePending(reason="no ready pod under cap")

    # Every (re)assignment bumps the fence generation so a stale prior owner can be detected.
    return Assign(host_pod=host, generation=conv.generation + 1, host_ip=ip_of.get(host))


# --- agent-host autoscaling (pure decision) --------------------------------
# The controller is the single writer of the agent-host Deployment's spec.replicas, so no HPA
# may run alongside it.

import math


# Phases that hold no pod slot and so are excluded from autoscale demand.
_NON_DEMAND_PHASES = frozenset({"Suspended", "Failed"})


def deletion_costs(pods: list[Pod], convs: list["ConversationState"]) -> dict[str, int]:
    """Per-pod pod-deletion-cost, the number of top-level Assigned conversations it hosts, so a scale-down picks empty pods first."""
    counts: dict[str, int] = {p.name: 0 for p in pods}
    for c in convs:
        if c.phase == "Assigned" and c.host_pod in counts and c.parent_id is None:
            counts[c.host_pod] += 1
    return counts


def demand_of(convs: list["ConversationState"]) -> int:
    """The autoscale demand: top-level conversations in a phase that needs a pod."""
    return sum(
        1
        for c in convs
        if c.parent_id is None and c.phase not in _NON_DEMAND_PHASES
    )


def desired_replicas(
    demand: int,
    cap: int,
    min_replicas: int,
    max_replicas: int,
) -> int:
    """The target agent-host replica count, ceil(demand / cap) clamped to [min_replicas, max_replicas]; the caller applies the scale-down cooldown."""
    if cap < 1:
        cap = 1
    need = math.ceil(demand / cap) if demand > 0 else 0
    target = max(min_replicas, need)
    return min(target, max_replicas)


# --- orphaned-Sandbox reaper (pure decision) -------------------------------
# The controller GCs Sandboxes no conversations row references.

@dataclass(frozen=True)
class SandboxRef:
    """The bits of a Sandbox CR the reaper decision depends on."""

    name: str            # metadata.name
    age_seconds: float   # now - metadata.creationTimestamp
    operating_mode: str | None = None  # spec.operatingMode, which the reaper decision ignores
    suspended_seconds: float | None = None  # time since the Suspended condition became True


def find_expired_overlays(
    sandboxes: list[SandboxRef],
    pvc_names: set[str],
    retention_seconds: float,
) -> list[str]:
    """Overlay PVCs suspended past retention; never a workspace."""
    if retention_seconds <= 0:
        return []
    return [
        f"scooter-rw-{sb.name}"
        for sb in sandboxes
        if sb.operating_mode == "Suspended"
        and sb.suspended_seconds is not None
        and sb.suspended_seconds >= retention_seconds
        and f"scooter-rw-{sb.name}" in pvc_names
    ]


def find_expired_sandboxes(
    sandboxes: list[SandboxRef],
    reapable: set[str],
    retention_seconds: float,
) -> list[str]:
    """Sandboxes suspended past retention whose rows all allow reaping."""
    if retention_seconds <= 0:
        return []
    return [
        sb.name
        for sb in sandboxes
        if sb.name in reapable
        and sb.operating_mode == "Suspended"
        and sb.suspended_seconds is not None
        and sb.suspended_seconds >= retention_seconds
    ]


def find_orphans(
    sandboxes: list[SandboxRef],
    referenced: set[str],
    grace_seconds: float,
) -> list[str]:
    """Names of Sandboxes no Conversation references that are older than `grace_seconds`, which spares a Sandbox whose conversation has not been registered yet."""

    return [
        sb.name
        for sb in sandboxes
        if sb.name not in referenced and sb.age_seconds >= grace_seconds
    ]
