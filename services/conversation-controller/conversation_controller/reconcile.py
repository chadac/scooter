"""The pure reconcile core — decides what to do with one Conversation, given the
current agent-host pods and their load. No k8s, no I/O — so it's fully unit-testable.
The controller loop (loop.py) is the imperative shell that lists, calls this per
conversation, and patches status.

Assignment model:
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
    phase: str                 # status.phase (Pending | Assigned | Orphaned) — "Pending" default
    generation: int            # status.generation (the fence epoch)
    host_ip: str | None = None # status.hostIP (owner pod IP — routing address)
    parent_id: str | None = None  # spec.parentId — a subagent co-locates on its parent's pod
    # False when the CR carries NO status.phase yet (status: null) — the shell must still
    # materialize Pending for such a CR even though `phase` defaulted to "Pending".
    phase_present: bool = True
    # The backing Sandbox's spec.operatingMode ("Running" | "Suspended"), or None when the
    # Sandbox does not exist (never created yet, or already reaped). The Sandbox is the TRUTH
    # for alive/suspended — see the drift rule in reconcile() and
    sandbox_mode: str | None = None


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


@dataclass(frozen=True)
class Detach:
    """A SUSPENDED conversation needs no pod — release its placement (clear BOTH hostPod, the
    fencing identity, AND hostIP, the routing address). Phase stays Suspended (the agent-host
    owns that transition); we only release placement. On wake, the host sets phase=Assigned and
    the next reconcile assigns a fresh host. Clearing hostIP is essential: the router keys on
    hostIP, so a lingering (now-dead) hostIP makes it dial a deleted pod forever
    (docs/scooter-bug-stale-hostip-routes-to-dead-pod.md)."""
    reason: str


@dataclass(frozen=True)
class MarkSuspended:
    """The CR's phase has DRIFTED from its Sandbox: the sandbox is operatingMode=Suspended but
    the phase still says Assigned/Pending. Force phase → Suspended and release placement.

    Why drift happens (all observed live): the host's setPhase("Suspended") is OWNER-fenced, so
    any suspend not driven by the CR's assigned owner never publishes — another pod's idle sweep
    (multi-pod hydrate means every pod sweeps), agent-sandbox's own idle timer on a conversation
    that never had a live owner, or an owner that died between suspending the sandbox and
    writing the phase. The controller then counts the phantom as demand FOREVER (phase != 
    Suspended), so the fleet never scales down.

    The Sandbox is the source of truth for alive/suspended. Convergent last-writer-wins: a real
    revive patches the sandbox Running FIRST, then writes Assigned — if a stale read stomps that
    Assigned, the next interaction re-publishes it and the sweep reclaims the sandbox either
    way."""
    reason: str


Action = NoOp | Assign | LeavePending | Detach | MarkSuspended


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

    # SUSPENDED conversations need NO pod — the agent-host set phase=Suspended (idle-suspend).
    # Respect it: never (re)assign a suspended conversation, and RELEASE any stale placement it
    # still carries (suspend() writes phase but not hostPod/hostIP, so a just-suspended conv
    # still points at its old — now draining — pod). WITHOUT this, when that pod dies the
    # placement logic below would see "host gone" and RE-ASSIGN it (clobbering Suspended →
    # Assigned), putting it back in the autoscale demand → the fleet never sleeps. On wake the
    # host sets phase=Assigned (a request reaches any pod via the router's hostless fallback)
    # and the next reconcile assigns a fresh host. Subagents follow their parent, so a suspended
    # subagent is covered by the parent's suspension (its own phase tracks too).
    #
    # Detach on EITHER placement field being set — including a lingering hostIP with no hostPod.
    # After a rollout the suspend path (or a prior partial Detach) can leave {hostPod: null,
    # hostIP: <dead pod>}; the router keys on hostIP and would dial that dead address forever.
    # Repair it — a Detach clears BOTH — so hostIP is never non-empty while hostPod is empty
    # (docs/scooter-bug-stale-hostip-routes-to-dead-pod.md).
    # DRIFT REPAIR: the Sandbox says Suspended but the phase does not. Fires only on an
    # EXISTING suspended Sandbox — an ABSENT one (sandbox_mode None) is deliberately ignored:
    # start() registers the CR before the provisioner creates the Sandbox, so absence can mean
    # "being born", and stomping a newborn to Suspended would break it. Absence is not evidence.
    if conv.phase != "Suspended" and conv.sandbox_mode == "Suspended":
        return MarkSuspended(
            reason=f"phase={conv.phase} but sandbox is Suspended — reconciling phase to the sandbox"
        )

    if conv.phase == "Suspended":
        if conv.host_pod is not None or conv.host_ip is not None:
            return Detach(reason="suspended — release placement (clear hostPod + hostIP)")
        return NoOp(reason="suspended — no placement to release")

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


# --- agent-host autoscaling (pure decision) --------------------------------
# The controller IS the autoscaler: it already lists Conversations + pods every tick, so it
# owns "how many agent-host pods do these conversations need." desired = ceil(demand / cap),
# clamped to [min, max]. Demand = top-level conversations (subagents co-locate on the parent's
# pod → no independent capacity, same rule as assignment). Single-writer (patches the
# Deployment's spec.replicas) — do NOT also run an HPA on replicas (two writers fight). A
# custom conversations-per-pod METRIC is still exported for observability / a future HPA.

import math


# Phases that DO NOT consume a pod slot → excluded from autoscale demand. A Suspended
# conversation has no pod (its Sandbox is suspended); it revives on the next prompt (the
# host resumes it + republishes Assigned), so it must not hold a replica open while idle.
# WITHOUT this exclusion the fleet never scales down: every conversation ever created keeps
# counting as demand, so idle-suspended conversations pin the agent-host at max — the
# "conversations still not sleeping" symptom (the pods stay up though the Sandboxes suspend).
_NON_DEMAND_PHASES = frozenset({"Suspended"})


def demand_of(convs: list["ConversationState"]) -> int:
    """Top-level conversations that NEED a pod right now — the autoscale demand. Excludes
    subagents (they co-locate on the parent's pod, consuming no independent capacity) AND
    Suspended conversations (no pod; revive on demand). Pending + Assigned count."""
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
    """The target agent-host replica count for `demand` top-level conversations at `cap`
    conversations/pod, clamped to [min_replicas, max_replicas]. HYSTERESIS: scale UP promptly
    (a Pending conversation is a user waiting), but never scale DOWN below what's needed +
    never below min — the CALLER applies a cooldown so a brief dip doesn't drop a pod
    mid-conversation (see loop.autoscale_once). Pure: given the counts, return the target.

    - demand 0 → min_replicas (keep a warm floor; never scale to 0).
    - Rounds UP: 3 convs @ cap 2 → 2 pods (never leave a conversation without a slot).
    """
    if cap < 1:
        cap = 1
    need = math.ceil(demand / cap) if demand > 0 else 0
    target = max(min_replicas, need)
    return min(target, max_replicas)


# --- orphaned-Sandbox reaper (pure decision) -------------------------------
# A Sandbox with no owning Conversation leaks forever: the per-pod agent-host retention
# sweep only sees in-memory conversations, so a Sandbox whose Conversation CR is gone from
# every pod's memory (deleted CR, lost state across redeploy/migration, crash between
# provisioner-create and CR-register) is never reaped. The controller — where the CR is
# authoritative — reconciles Sandboxes against Conversations and GCs the difference.

@dataclass(frozen=True)
class SandboxRef:
    """The bits of a Sandbox CR the reaper decision depends on."""

    name: str            # metadata.name (e.g. conv-<id>)
    age_seconds: float   # now - metadata.creationTimestamp
    # spec.operatingMode ("Running" | "Suspended"); None for callers that don't need it (the
    # reaper decision ignores it — it keys on referenced-ness and age).
    operating_mode: str | None = None


def find_orphans(
    sandboxes: list[SandboxRef],
    referenced: set[str],
    grace_seconds: float,
) -> list[str]:
    """Names of Sandboxes to reap: those NOT referenced by any Conversation (via
    spec.sandboxRef) AND older than `grace_seconds`. The grace window spares a just-created
    Sandbox whose Conversation CR hasn't been registered yet (the provisioner creates the
    Sandbox a beat before the CR) — only genuine orphans are reaped. Pure + order-stable.

    `referenced` is the set of sandbox NAMES any Conversation points at (its spec.sandboxRef,
    across ALL conversations incl. subagents — a subagent shares its parent's sandbox, and
    the parent conversation references it, so co-located pods are protected as long as the
    parent conversation exists)."""
    return [
        sb.name
        for sb in sandboxes
        if sb.name not in referenced and sb.age_seconds >= grace_seconds
    ]
