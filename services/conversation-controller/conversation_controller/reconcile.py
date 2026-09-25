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
    # controller.kubernetes.io/pod-deletion-cost currently on the pod (None = unset).
    # Carried so the loop patches only on CHANGE, not every tick.
    deletion_cost: int | None = None
    # metadata.deletionTimestamp is set: the pod is on its way OUT (a scale-down
    # victim draining gracefully). It can report Ready for its whole grace period —
    # assigning a conversation to it just schedules another mid-run reassignment
    # (observed: assigned 23:40:26, reassigned 23:40:34, same conversation).
    terminating: bool = False


@dataclass(frozen=True)
class ConversationState:
    """The bits of a Conversation CR the decision depends on."""

    name: str
    host_pod: str | None       # status.hostPod (owner pod NAME — fencing identity)
    phase: str                 # status.phase (Pending | Assigned | Orphaned) — "Pending" default
    generation: int            # status.generation (the fence epoch)
    host_ip: str | None = None # status.hostIP (owner pod IP — routing address)
    creator_pod: str | None = None  # spec.creatorPod — where the conversation PHYSICALLY runs
    parent_id: str | None = None  # spec.parentId — a subagent co-locates on its parent's pod
    # False when the CR carries NO status.phase yet (status: null) — the shell must still
    # materialize Pending for such a CR even though `phase` defaulted to "Pending".
    phase_present: bool = True
    # The backing Sandbox's spec.operatingMode ("Running" | "Suspended"), or None when the
    # Sandbox does not exist (never created yet, or already reaped). The Sandbox is the TRUTH
    # for alive/suspended — see the drift rule in reconcile() and
    # todo/docs/CONVERSATION_PHASE_DRIFT_RECONCILE.md.
    sandbox_mode: str | None = None
    sandbox_ref: str | None = None  # spec.sandboxRef — the Sandbox object SuspendSandbox patches


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
class RepairHostIP:
    """The owner (hostPod) is unchanged and still ready, but status.hostIP — the address
    the router actually dials — is stale or missing. Re-publish JUST hostIP; DON'T touch
    hostPod, phase, or generation (the owner hasn't moved, so bumping the fence would
    needlessly fence the live run).

    Why hostIP drifts while hostPod stays ready:
      - It's written from the pod's status.podIP at Assign time, which is None if the podIP
        wasn't observed yet — so a conversation assigned a beat before its pod's IP appeared
        gets hostIP=None PERMANENTLY, because the "host still ready" branch used to NoOp and
        never revisit it.
      - A pod replaced under a stable name (StatefulSet-style) keeps the name but changes IP.
    The router keys on hostIP: empty/stale → it falls back to the ClusterIP Service, which
    load-balances every request to a RANDOM pod. A non-owner then serves the integrity
    replay and ENDS the stream (streamOwnership="elsewhere"), the client reconnects, and
    lands on yet another random pod — so with N replicas two tabs on the same conversation
    each have ~1/N odds of hitting the owner: one streams live, the other goes silent."""
    host_pod: str              # unchanged owner (for logging/co-location bookkeeping)
    host_ip: str               # the owner pod's CURRENT status.podIP


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


@dataclass
class SuspendSandbox:
    """The ZOMBIE repair: phase=Suspended, placement fully released — yet the Sandbox is
    RUNNING. Every host has evicted the conversation (that is what Suspended means), so
    the doctrine's recovery path — "the sweep reclaims the sandbox either way" — is
    structurally unreachable: no sweep will ever visit it again. Observed on valhalla as
    sandbox pods running 9-12h (a racing sweeper's exec probe resumed a just-suspended
    sandbox via the pollForReadyPod self-heal, then both pods evicted the conversation).

    The loop confirms this across TWO consecutive ticks before acting: a real revive
    patches the sandbox Running BEFORE writing phase=Assigned, so a single-tick sighting
    can be a revive mid-flight and must not be stomped."""
    reason: str


Action = NoOp | Assign | RepairHostIP | LeavePending | Detach | MarkSuspended | SuspendSandbox


def _host_ip_drift(host_pod: str, host_ip: str | None, ip_of: dict[str, str | None]) -> str | None:
    """The owner pod's CURRENT IP when it differs from the recorded hostIP and is known,
    else None (nothing to repair). Only acts on a KNOWN current IP: if the pod is ready but
    its podIP isn't observed yet (ip_of[host_pod] is None) we leave hostIP as-is and let a
    later tick converge it — we never blank a hostIP we can't replace."""
    current = ip_of.get(host_pod)
    if current is not None and current != host_ip:
        return current
    return None


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

    # TERMINAL. Failed is the zombie-repair escalation's dead end: after N bounded suspends
    # that never took, the loop force-deleted the Sandbox and marked the conversation Failed
    # (see loop._zombie_progress). Take NO further action — never (re)assign it, never re-flag
    # it as a zombie. An operator investigates via the Failed phase; it counts as no demand.
    if conv.phase == "Failed":
        return NoOp(reason="failed — terminal, no action")

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
        if conv.sandbox_mode == "Running":
            return SuspendSandbox(
                reason="suspended + unhosted but the Sandbox is RUNNING — zombie (or a revive mid-flight; loop confirms over two ticks)"
            )
        return NoOp(reason="suspended — no placement to release")

    # A subagent is PINNED to its parent's pod (shared sandbox) — cap doesn't apply.
    if conv.parent_id is not None:
        parent_host = hosts.get(conv.parent_id)
        # Already co-located on the parent's ready pod → done (but converge a stale/missing
        # hostIP first: a subagent's hostIP tracks the shared parent pod's IP and drifts the
        # same way a top-level owner's does — see RepairHostIP).
        if conv.host_pod is not None and conv.host_pod == parent_host and parent_host in ready_names:
            drift = _host_ip_drift(conv.host_pod, conv.host_ip, ip_of)
            if drift is not None:
                return RepairHostIP(host_pod=conv.host_pod, host_ip=drift)
            return NoOp(reason=f"co-located with parent on {parent_host}")
        # Parent not yet assigned to a ready pod → wait (don't scatter the child).
        if parent_host is None or parent_host not in ready_names:
            return LeavePending(reason=f"parent {conv.parent_id} not on a ready pod yet")
        # Pin (or re-pin) to the parent's pod, bumping the fence generation.
        return Assign(host_pod=parent_host, generation=conv.generation + 1, host_ip=ip_of.get(parent_host))

    # Already assigned to a live, ready pod. The OWNER is correct — don't reassign (a fence
    # bump would fence the live run) — but CONVERGE the routing address: hostIP can be stale
    # or missing while hostPod stays ready, and a NoOp here would leave the router dialing a
    # dead/empty address forever (the two-tabs-one-goes-silent bug — see RepairHostIP).
    if conv.host_pod is not None and conv.host_pod in ready_names:
        drift = _host_ip_drift(conv.host_pod, conv.host_ip, ip_of)
        if drift is not None:
            return RepairHostIP(host_pod=conv.host_pod, host_ip=drift)
        return NoOp(reason=f"host {conv.host_pod} still ready")

    # PREFER THE CREATOR. The run physically lives on the pod that created the
    # conversation (bridge, sandbox exec, local event log); a least-loaded pick that
    # lands elsewhere splits run from owner — the run's appends get fenced off mid-run,
    # the "owner" has nothing live to stream, and the UI sits at "Working…" forever.
    # Bypasses the cap for the same reason a subagent pins to its parent: the work is
    # already THERE, and assigning it away does not free that capacity.
    if conv.creator_pod is not None and conv.creator_pod in ready_names:
        return Assign(
            host_pod=conv.creator_pod,
            generation=conv.generation + 1,
            host_ip=ip_of.get(conv.creator_pod),
        )

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
# See todo/docs/AGENT_HOST_FLEET_SCALING.md.

import math


# Phases that DO NOT consume a pod slot → excluded from autoscale demand. A Suspended
# conversation has no pod (its Sandbox is suspended); it revives on the next prompt (the
# host resumes it + republishes Assigned), so it must not hold a replica open while idle.
# WITHOUT this exclusion the fleet never scales down: every conversation ever created keeps
# counting as demand, so idle-suspended conversations pin the agent-host at max — the
# "conversations still not sleeping" symptom (the pods stay up though the Sandboxes suspend).
# Failed is terminal (the zombie escalation gave up on it) — it has no pod either.
_NON_DEMAND_PHASES = frozenset({"Suspended", "Failed"})


def deletion_costs(pods: list[Pod], convs: list["ConversationState"]) -> dict[str, int]:
    """Per-pod `controller.kubernetes.io/pod-deletion-cost`: the number of TOP-LEVEL
    Assigned conversations the pod hosts (same accounting as demand_of — subagents
    co-locate and Suspended conversations have no pod). Kubernetes deletes the
    LOWEST-cost pods first on a Deployment scale-down, so annotating hosted-count
    steers victim selection to EMPTY pods. Without this the victim choice was blind:
    a scale-down 10s after a conversation was assigned killed its pod mid-run — the
    stream died, the run's terminal event was lost, and the browser showed
    "Working…" forever (e2e-full stop-family failures; the valhalla rollout bug).
    """
    counts: dict[str, int] = {p.name: 0 for p in pods}
    for c in convs:
        if c.phase == "Assigned" and c.host_pod in counts and c.parent_id is None:
            counts[c.host_pod] += 1
    return counts


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
# See todo/docs/ORPHANED_SANDBOX_REAPER.md.

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
