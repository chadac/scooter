"""The pure reconcile core — decides what to do with one Conversation, given the
current agent-host pods and their load. No k8s, no I/O — so it's fully unit-testable.
The controller loop (loop.py) is the imperative shell that lists, calls this per
conversation, and patches status.

Assignment model (see todo/docs/CONVERSATION_CRD_PR1.md):
- A Conversation is pinned to exactly one READY agent-host pod (`status.hostPod`).
- Pick the least-loaded ready pod under a per-pod cap.
- If the assigned pod is gone / NotReady, reassign (bumping the fence `generation`).
- If no pod can take it (all at cap / none ready), leave it Pending.
- A SUBAGENT (spec.parentId set) must be CO-LOCATED with its parent: it shares the
  parent's sandbox pod and its writes exec into that pod, so it's pinned to the parent's
  host_pod, bypassing the cap (it consumes no independent capacity). If the parent isn't
  assigned to a ready pod yet, the child stays Pending until it is.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Pod:
    name: str
    ready: bool
    ip: str | None = None      # status.podIP — the routing address written into the CR (None until scheduled)


@dataclass(frozen=True)
class ConversationState:
    """The bits of a Conversation CR the decision depends on."""

    name: str
    host_pod: str | None       # status.hostPod (owner pod NAME — fencing identity)
    phase: str                 # status.phase (Pending | Assigned | Orphaned)
    generation: int            # status.generation (the fence epoch)
    host_ip: str | None = None # status.hostIP (owner pod IP — routing address)
    parent_id: str | None = None  # spec.parentId — a subagent co-locates on its parent's pod


# --- Actions the shell will apply -----------------------------------------

@dataclass(frozen=True)
class NoOp:
    reason: str


@dataclass(frozen=True)
class Assign:
    host_pod: str              # owner pod NAME (fencing identity)
    generation: int            # the new generation to write
    phase: str = "Assigned"
    host_ip: str | None = None # owner pod IP (routing address) — the chosen pod's status.podIP


@dataclass(frozen=True)
class LeavePending:
    """No ready pod under cap can take it — record Pending (no host)."""
    reason: str


Action = NoOp | Assign | LeavePending


def pick_host(pods: list[Pod], load: dict[str, int], cap: int) -> str | None:
    """The least-loaded READY pod strictly under `cap`, or None. Deterministic tie-break
    by pod name so the choice is stable across reconciles (no assignment churn)."""
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
    """Decide the action for one Conversation. `load` counts CURRENT assignments per pod
    (excluding `conv` itself if already counted — the shell computes it consistently).
    `hosts` maps conversation name → its host_pod, used to co-locate a subagent on its
    parent's pod (default {} = no parent lookups)."""
    hosts = hosts or {}
    ready_names = {p.name for p in pods if p.ready}
    ip_of = {p.name: p.ip for p in pods}  # pod name → its status.podIP (routing address)

    # A subagent is PINNED to its parent's pod (shared sandbox) — cap doesn't apply.
    if conv.parent_id is not None:
        parent_host = hosts.get(conv.parent_id)
        # Already co-located on the parent's ready pod → done.
        if conv.host_pod is not None and conv.host_pod == parent_host and parent_host in ready_names:
            return NoOp(reason=f"co-located with parent on {parent_host}")
        # Parent not yet assigned to a ready pod → wait (don't scatter the child).
        if parent_host is None or parent_host not in ready_names:
            return LeavePending(reason=f"parent {conv.parent_id} not on a ready pod yet")
        # Pin (or re-pin) to the parent's pod, bumping the fence generation.
        return Assign(host_pod=parent_host, generation=conv.generation + 1, host_ip=ip_of.get(parent_host))

    # Already assigned to a live, ready pod → nothing to do.
    if conv.host_pod is not None and conv.host_pod in ready_names:
        return NoOp(reason=f"host {conv.host_pod} still ready")

    # Assigned to a pod that's gone/NotReady, OR never assigned → (re)assign.
    host = pick_host(pods, load, cap)
    if host is None:
        return LeavePending(reason="no ready pod under cap")

    # Bump the fence generation on every (re)assignment so a stale prior owner can be
    # detected later (routing PR read-checks it before appending).
    return Assign(host_pod=host, generation=conv.generation + 1, host_ip=ip_of.get(host))
