"""The pure reconcile core — decides what to do with one Conversation, given the
current agent-host pods and their load. No k8s, no I/O — so it's fully unit-testable.
The controller loop (loop.py) is the imperative shell that lists, calls this per
conversation, and patches status.

Assignment model (see todo/docs/CONVERSATION_CRD_PR1.md):
- A Conversation is pinned to exactly one READY agent-host pod (`status.hostPod`).
- Pick the least-loaded ready pod under a per-pod cap.
- If the assigned pod is gone / NotReady, reassign (bumping the fence `generation`).
- If no pod can take it (all at cap / none ready), leave it Pending.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Pod:
    name: str
    ready: bool


@dataclass(frozen=True)
class ConversationState:
    """The bits of a Conversation CR the decision depends on."""

    name: str
    host_pod: str | None       # status.hostPod
    phase: str                 # status.phase (Pending | Assigned | Orphaned)
    generation: int            # status.generation (the fence epoch)


# --- Actions the shell will apply -----------------------------------------

@dataclass(frozen=True)
class NoOp:
    reason: str


@dataclass(frozen=True)
class Assign:
    host_pod: str
    generation: int            # the new generation to write
    phase: str = "Assigned"


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


def reconcile(conv: ConversationState, pods: list[Pod], load: dict[str, int], cap: int) -> Action:
    """Decide the action for one Conversation. `load` counts CURRENT assignments per pod
    (excluding `conv` itself if already counted — the shell computes it consistently)."""
    ready_names = {p.name for p in pods if p.ready}

    # Already assigned to a live, ready pod → nothing to do.
    if conv.host_pod is not None and conv.host_pod in ready_names:
        return NoOp(reason=f"host {conv.host_pod} still ready")

    # Assigned to a pod that's gone/NotReady, OR never assigned → (re)assign.
    host = pick_host(pods, load, cap)
    if host is None:
        return LeavePending(reason="no ready pod under cap")

    # Bump the fence generation on every (re)assignment so a stale prior owner can be
    # detected later (routing PR read-checks it before appending).
    return Assign(host_pod=host, generation=conv.generation + 1)
