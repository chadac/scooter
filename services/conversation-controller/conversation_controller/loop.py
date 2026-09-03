"""The reconcile LOOP — the imperative shell around reconcile.py. Lists pods +
Conversations, computes per-pod load, decides each conversation's action, applies the
status patch. Leader-gated by the caller (only the Lease holder runs reconcile_once).

Kept free of I/O DETAILS: it takes a ControllerK8s (real or fake), so the whole loop is
unit-testable against an in-memory fake (see test_loop.py)."""

from __future__ import annotations

import logging

from dataclasses import dataclass

from .logging_config import forget_warned, warn_once

from .reconcile import (
    ConversationState,
    Assign,
    NoOp,
    LeavePending,
    Detach,
    MarkSuspended,
    reconcile,
    find_orphans,
    desired_replicas,
    deletion_costs,
    demand_of,
    SuspendSandbox,
)

logger = logging.getLogger(__name__)
_C = {"component": "loop"}


def _state(cr: dict, sandbox_modes: dict[str, str | None] | None = None) -> ConversationState:
    st = cr.get("status") or {}
    spec = cr.get("spec") or {}
    ref = spec.get("sandboxRef")
    return ConversationState(
        name=cr["metadata"]["name"],
        host_pod=st.get("hostPod"),
        # None when the Sandbox doesn't exist (or the ref is unset) — the drift rule treats
        # absence as no-evidence, never as suspension (the creation race).
        sandbox_mode=(sandbox_modes or {}).get(ref) if ref else None,
        sandbox_ref=ref,
        creator_pod=spec.get("creatorPod"),
        phase=st.get("phase", "Pending"),
        # Whether the CR actually carries a phase (vs. the "Pending" default above). A
        # status-less CR (status: null / no phase) needs its phase MATERIALIZED even when it
        # stays Pending — see the LeavePending branch.
        phase_present=st.get("phase") is not None,
        generation=int(st.get("generation", 0)),
        host_ip=st.get("hostIP"),
        parent_id=spec.get("parentId"),
    )


# ZOMBIE repair — backoff + terminal resolution. Module-level state: one controller process,
# one loop.
#
# A zombie is (phase=Suspended, unhosted, Sandbox operatingMode=Running) — reconcile returns
# SuspendSandbox for it. The naive repair re-issued the SAME suspend every tick: if the suspend
# never takes — which is exactly why a sandbox is a zombie (a racing sweeper's exec probe keeps
# reviving the pod via the pollForReadyPod self-heal) — the conversation re-armed and was
# re-suspended every ~5s forever (production: the same sandboxes re-detected + re-suspended
# indefinitely). So instead:
#   1. TWO-TICK CONFIRMATION (unchanged) — a real revive patches the Sandbox Running BEFORE
#      writing phase=Assigned, so one sighting can be a revive mid-flight and must not be acted
#      on. Act only on the second consecutive sighting.
#   2. BACKOFF — after issuing a suspend, wait a few ticks before the next one (never re-issue
#      every tick).
#   3. TERMINAL ESCALATION — after N suspends that don't take, stop fighting the upstream resume
#      race: force-delete the Sandbox (reclaims the leaked running pod) and mark the conversation
#      Failed (a terminal phase reconcile then leaves inert; an operator investigates). Logged
#      ONCE, not per tick.
_ZOMBIE_CONFIRM_TICKS = 2          # consecutive sightings before the first suspend (false-positive guard)
_ZOMBIE_SUSPEND_BACKOFF_TICKS = 3  # ticks to wait between suspends (no re-issue every tick)
_ZOMBIE_MAX_SUSPENDS = 3           # bounded suspend attempts before the terminal escalation


@dataclass
class _ZombieProgress:
    confirms: int = 0       # consecutive ticks reconcile flagged this conversation as a zombie
    suspends: int = 0       # suspend patches issued so far
    cooldown: int = 0       # ticks remaining before the next suspend is allowed (backoff window)
    resolved: bool = False  # terminal escalation done — take no further action, and do NOT re-log


_zombie_progress: dict[str, _ZombieProgress] = {}


def reconcile_once(k8s, cap: int) -> list[tuple[str, str]]:
    """One reconcile pass over all Conversations. Returns [(name, action_kind)] for
    logging/tests. Only mutates via k8s.patch_status. The LOAD each conversation sees
    already excludes conversations that are being (re)assigned this pass — we compute it
    from the CURRENT status and update it as we assign, so a burst of Pending
    conversations spreads across pods instead of all landing on the least-loaded one."""
    pods = k8s.list_host_pods()
    # "Ready" for ASSIGNMENT excludes terminating pods: a scale-down victim reports
    # Ready through its grace period, and assigning to it schedules the very mid-run
    # reassignment the deletion-cost annotation exists to prevent.
    ready_names = {p.name for p in pods if p.ready and not p.terminating}
    # One Sandbox list per tick: the DRIFT rule needs each conversation's backing
    # operatingMode (the Sandbox is the truth for alive/suspended — see MarkSuspended).
    # BEST-EFFORT, same rule the reaper documents: sandbox listing is auxiliary and must
    # NOT abort assignment. In a fake-sandbox stack (the k3d smoke, local dev) the Sandbox
    # CRD does not exist and this call 404s — an unguarded throw here killed every tick
    # before any assignment. No sandbox info = no evidence = no drift repairs this tick.
    try:
        sandbox_modes = {sb.name: sb.operating_mode for sb in k8s.list_sandboxes()}
    except Exception:  # noqa: BLE001
        logger.warning(
            "list_sandboxes failed", extra={**_C, "skipped": "drift-repair"}, exc_info=True
        )
        sandbox_modes = {}
    convs = [_state(cr, sandbox_modes) for cr in k8s.list_conversations()]

    # Seed load from conversations currently assigned to a still-ready pod (those stay).
    load: dict[str, int] = {}
    for c in convs:
        if c.host_pod is not None and c.host_pod in ready_names:
            load[c.host_pod] = load.get(c.host_pod, 0) + 1

    # hosts maps conversation name → its current host_pod, so a subagent can co-locate on
    # its parent. Seed from current status; update as we assign this pass. Process PARENTS
    # before CHILDREN (parentless first) so a child sees its parent's fresh assignment.
    hosts: dict[str, str | None] = {c.name: c.host_pod for c in convs}
    convs.sort(key=lambda c: c.parent_id is not None)

    results: list[tuple[str, str]] = []
    # Conversations flagged as zombies THIS pass — used to reset the per-conversation
    # confirmation/backoff state for any that are no longer zombies (a false-positive revive,
    # or a resolved-and-now-terminal conversation).
    zombie_flagged: set[str] = set()
    drift_flagged: set[str] = set()  # forgotten below, so a later drift is loud again
    for c in convs:
        action = reconcile(c, pods, load, cap, hosts)
        if isinstance(action, NoOp):
            results.append((c.name, "noop"))
            continue
        if isinstance(action, SuspendSandbox):
            zombie_flagged.add(c.name)
            prog = _zombie_progress.setdefault(c.name, _ZombieProgress())

            # Terminal already reached — the escalation force-deleted the Sandbox and marked the
            # conversation Failed. Do nothing, and do NOT re-log (resolution is logged once).
            if prog.resolved:
                results.append((c.name, "zombie-resolved"))
                continue

            prog.confirms += 1

            # TWO-TICK CONFIRMATION: a single sighting can be a revive mid-flight — only a
            # suspect, no action yet.
            if prog.confirms < _ZOMBIE_CONFIRM_TICKS:
                logger.info(
                    "zombie sandbox suspect — confirming next tick",
                    extra={**_C, "conversation_id": c.name, "sandbox": c.sandbox_ref or ""},
                )
                results.append((c.name, "suspend-sandbox-suspect"))
                continue

            # BACKOFF: within the wait window after a suspend — hold, do not re-issue.
            if prog.cooldown > 0:
                prog.cooldown -= 1
                results.append((c.name, "suspend-sandbox-backoff"))
                continue

            # TERMINAL ESCALATION: N suspends have not taken. Stop fighting the resume race —
            # force-delete the Sandbox (reclaims the leaked running pod) and mark the
            # conversation Failed. Logged ONCE.
            if prog.suspends >= _ZOMBIE_MAX_SUSPENDS:
                if c.sandbox_ref:
                    k8s.force_delete_sandbox(c.sandbox_ref)
                k8s.patch_status(c.name, {"phase": "Failed"})
                prog.resolved = True
                logger.error(
                    "zombie sandbox unresolved — escalating (force-delete Sandbox + mark conversation Failed)",
                    extra={
                        **_C,
                        "conversation_id": c.name,
                        "sandbox": c.sandbox_ref or "",
                        "suspend_attempts": prog.suspends,
                        "reason": action.reason,
                    },
                )
                results.append((c.name, "zombie-escalated"))
                continue

            # Issue one bounded suspend and open the backoff window.
            prog.suspends += 1
            prog.cooldown = _ZOMBIE_SUSPEND_BACKOFF_TICKS
            logger.warning(
                "zombie sandbox — re-suspending",
                extra={
                    **_C,
                    "conversation_id": c.name,
                    "sandbox": c.sandbox_ref or "",
                    "attempt": prog.suspends,
                    "max_attempts": _ZOMBIE_MAX_SUSPENDS,
                    "reason": action.reason,
                },
            )
            if c.sandbox_ref:
                k8s.suspend_sandbox(c.sandbox_ref)
            results.append((c.name, "suspend-sandbox"))
            continue
        if isinstance(action, Detach):
            # A SUSPENDED conversation that still carries stale placement → release it (the
            # controller owns hostPod/hostIP; the agent-host owns the Suspended phase, which we
            # leave as-is). Clear BOTH the fencing identity (hostPod) AND the routing address
            # (hostIP): hostPod so a suspended conversation isn't shown "on" a dead pod and the
            # placement/demand logic stops treating it as hosted; hostIP so the router stops
            # dialing the (now-dead) pod and falls back to a live one
            # (docs/scooter-bug-stale-hostip-routes-to-dead-pod.md). The invariant: hostIP is
            # empty whenever hostPod is empty. (Only patches when there's actually placement to
            # clear; reconcile returns NoOp once it's already {hostPod: null, hostIP: null}, so
            # no churn.)
            k8s.patch_status(c.name, {"hostPod": None, "hostIP": None})
            hosts[c.name] = None
            results.append((c.name, "detach"))
            continue
        if isinstance(action, MarkSuspended):
            # PHASE DRIFT: the sandbox is Suspended but the phase still says Assigned/Pending
            # (an owner-fenced setPhase that never fired, or an owner that died mid-suspend).
            # Reconcile the phase to the sandbox truth and release placement in ONE patch, so
            # the phantom stops counting as autoscale demand and the router stops routing to a
            # pod that no longer hosts it. Logged loudly — every silent operatingMode/phase
            # divergence so far has cost a debugging session.
            drift_flagged.add(c.name)
            # The repair runs every pass (cheap, idempotent); only the LOG is de-duped —
            # a drift that never clears is otherwise re-reported on every tick.
            warn_once(
                logger,
                f"phase-drift:{c.name}",
                "phase drift repaired",
                {**_C, "conversation_id": c.name, "reason": action.reason},
            )
            k8s.patch_status(c.name, {"phase": "Suspended", "hostPod": None, "hostIP": None})
            hosts[c.name] = None
            results.append((c.name, "mark-suspended"))
            continue
        if isinstance(action, LeavePending):
            # Write Pending unless it's ALREADY a materialized Pending with no host — i.e.
            # don't churn a CR that already says {phase: Pending, hostPod: null}. Critically,
            # a brand-new CR with NO status yet (status: null → _state defaults phase to
            # "Pending") must STILL be patched so its phase MATERIALIZES — else an unassignable
            # new conversation (all pods at cap) sits at status:null forever (empty phase in
            # the UI). `phase_present` distinguishes "genuinely Pending" from "defaulted".
            if c.host_pod is not None or not c.phase_present or c.phase != "Pending":
                k8s.patch_status(c.name, {"phase": "Pending", "hostPod": None})
            hosts[c.name] = None
            results.append((c.name, "pending"))
            continue
        # Assign / Reassign.
        assert isinstance(action, Assign)
        k8s.patch_status(c.name, {
            "phase": action.phase,
            "hostPod": action.host_pod,
            "hostIP": action.host_ip,
            "generation": action.generation,
        })
        hosts[c.name] = action.host_pod  # so a child reconciled later co-locates here
        # A subagent shares its parent's pod — don't double-count it toward pod capacity.
        if c.parent_id is None:
            load[action.host_pod] = load.get(action.host_pod, 0) + 1  # count it for the rest of this pass
        results.append((c.name, "assign"))
        logger.info(
            "assigned",
            extra={
                **_C,
                "conversation_id": c.name,
                "host_pod": action.host_pod,
                "host_ip": action.host_ip,
                "generation": action.generation,
            },
        )
        # Push the new host to revive the conversation from the mirror BEFORE user traffic
        # arrives (seamless rollout — see todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md). notify_revive
        # is FIRE-AND-FORGET (spawns a daemon thread) so a stale/unroutable hostIP can never
        # block the reconcile pass — the host also revives lazily on first request. The
        # try/except is a belt-and-suspenders guard on the thread SPAWN itself. Skipped when
        # the pod has no IP yet (just scheduled) — the next tick re-pushes once the IP is known.
        if action.host_ip:
            try:
                k8s.notify_revive(action.host_ip, c.name, action.generation)
            except Exception:  # noqa: BLE001 — never let a push failure abort the reconcile pass
                logger.warning(
                    "revive-push spawn failed",
                    extra={**_C, "conversation_id": c.name, "fallback": "lazy-revive"},
                    exc_info=True,
                )

    # Reset zombie state for any conversation NOT flagged this pass: this resets the two-tick
    # confirmation on a false positive (a revive mid-flight), and GCs a resolved record once the
    # conversation is terminal (Failed → reconcile no longer returns SuspendSandbox for it).
    for name in list(_zombie_progress.keys()):
        if name not in zombie_flagged:
            del _zombie_progress[name]

    # A conversation that did NOT drift this pass is forgotten, so a future drift is loud.
    forget_warned({f"phase-drift:{n}" for n in drift_flagged})

    return results


class AutoscaleState:
    """Mutable cooldown state the caller owns across ticks (scale-down hysteresis)."""

    def __init__(self) -> None:
        self.last_scale_down: float = 0.0


def autoscale_once(k8s, cfg, state: AutoscaleState, now: float) -> dict:
    """Scale the agent-host Deployment to fit conversation demand, and return metrics for
    export. Leader-gated by the caller. The controller IS the autoscaler — do NOT also run an
    HPA on agent-host replicas (two writers on spec.replicas fight).

    Demand = TOP-LEVEL conversations (subagents co-locate on the parent's pod, consuming no
    independent capacity — same rule as assignment). Scale UP immediately (a waiting user);
    scale DOWN only after a cooldown so a brief dip doesn't drop a pod mid-conversation.
    Returns {demand, current, target, ready_pods, per_pod} — per_pod is the observability
    metric (also exported at /metrics)."""
    convs = [_state(cr) for cr in k8s.list_conversations()]
    # Demand = top-level conversations that NEED a pod (Pending + Assigned). Suspended
    # conversations are excluded — they have no pod and revive on demand, so counting them
    # pinned the fleet at max and the pods never slept though the Sandboxes suspended.
    demand = demand_of(convs)
    pods = k8s.list_host_pods()
    ready_pods = sum(1 for p in pods if p.ready)
    current = k8s.get_agent_host_replicas()

    # BEFORE any scale decision: steer scale-down victim selection. Kubernetes kills
    # the lowest deletion-cost pods first, so pods hosting live conversations must
    # carry their hosted-count before a scale-down can pick victims. Patch only on
    # change (the annotation round-trips through list_host_pods).
    for pod_name, cost in deletion_costs(pods, convs).items():
        if next((p.deletion_cost for p in pods if p.name == pod_name), None) != cost:
            try:
                k8s.set_pod_deletion_cost(pod_name, cost)
            except Exception:  # noqa: BLE001 — annotation is protective, never tick-fatal
                logger.warning("set_pod_deletion_cost failed", extra={**_C, "pod": pod_name}, exc_info=True)

    target = desired_replicas(demand, cfg.pod_cap, cfg.min_replicas, cfg.max_replicas)
    per_pod = (demand / ready_pods) if ready_pods else float(demand)

    if target > current:
        # Scale UP immediately — a Pending conversation is a user waiting for a slot.
        k8s.set_agent_host_replicas(target)
        logger.info(
            "autoscale up",
            extra={**_C, "from_replicas": current, "to_replicas": target, "demand": demand, "pod_cap": cfg.pod_cap},
        )
    elif target < current:
        # Scale DOWN only after the cooldown (avoid flapping / dropping a pod on a brief dip).
        if now - state.last_scale_down >= cfg.scale_down_cooldown_seconds:
            k8s.set_agent_host_replicas(target)
            state.last_scale_down = now
            logger.info(
                "autoscale down",
                extra={**_C, "from_replicas": current, "to_replicas": target, "demand": demand, "pod_cap": cfg.pod_cap},
            )
        # else: within cooldown — hold at `current`.

    return {"demand": demand, "current": current, "target": target, "ready_pods": ready_pods, "per_pod": per_pod}


def reap_orphans(k8s, grace_seconds: float) -> list[str]:
    """One reaper pass: destroy Sandboxes with no owning Conversation, older than the grace
    window. Reaping deletes the whole per-conversation tree (Sandbox + its ServiceAccount +
    module ConfigMap) — the Sandbox delete cascades its pod + volumeClaimTemplate PVCs, but
    the SA + module CM are provisioner-created (not Sandbox-owned) so they DON'T cascade and
    must be deleted too. Leader-gated by the caller. Returns the reaped sandbox names.

    DESTRUCTIVE — logs every reap. Best-effort per sandbox: a failed delete is logged and the
    pass continues (retries next tick). See todo/docs/ORPHANED_SANDBOX_REAPER.md."""
    referenced: set[str] = {
        ref
        for cr in k8s.list_conversations()
        if (ref := (cr.get("spec") or {}).get("sandboxRef"))
    }
    orphans = find_orphans(k8s.list_sandboxes(), referenced, grace_seconds)
    reaped: list[str] = []
    for name in orphans:
        try:
            k8s.delete_sandbox_tree(name)
            reaped.append(name)
            logger.info(
                "reaped orphaned sandbox", extra={**_C, "sandbox_name": name, "reason": "no owning Conversation"}
            )
        except Exception:  # noqa: BLE001 — one failed reap must not abort the pass
            logger.exception(
                "reap of orphaned sandbox failed",
                extra={**_C, "sandbox_name": name, "will_retry_next_pass": True},
            )
    return reaped
