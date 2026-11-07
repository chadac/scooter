"""The reconcile loop: the imperative shell around reconcile.py.

Lists pods and the conversations rows (the source of truth), computes per-pod load, decides
each conversation's action and writes it to the row. The caller leader-gates it, and it takes a ControllerK8s
and a rows handle (real or fake) so the whole loop is unit-testable against in-memory fakes."""

from __future__ import annotations

import logging
import time

from dataclasses import dataclass

from .logging_config import expire_warned, warn_once

from .reconcile import (
    ConversationState,
    Assign,
    NoOp,
    LeavePending,
    Detach,
    MarkSuspended,
    reconcile,
    find_orphans,
    find_expired_sandboxes,
    find_expired_overlays,
    desired_replicas,
    deletion_costs,
    demand_of,
    SuspendSandbox,
)

logger = logging.getLogger(__name__)
_C = {"component": "loop"}


def _row_state(row: dict, sandbox_modes: dict[str, str | None], ip_of: dict[str, str]) -> ConversationState:
    ref = row.get("sandbox_ref")
    host = row.get("host_pod")
    return ConversationState(
        name=row["id"],
        host_pod=host,
        sandbox_mode=sandbox_modes.get(ref) if ref else None,
        sandbox_ref=ref,
        creator_pod=row.get("creator_pod"),
        phase=row.get("phase") or "Pending",
        phase_present=row.get("phase") is not None,
        generation=int(row.get("host_generation") or 0),
        host_ip=ip_of.get(host) if host else None,
        parent_id=row.get("parent_id"),
    )


# Zombie repair state (one controller process, one loop). A zombie is a Suspended, unhosted
# conversation whose Sandbox reads Running; a suspend is issued only on the second consecutive
# sighting, re-issued only after a backoff, and after a bounded number of attempts the leaked
# pod is reclaimed and the conversation marked Failed. The record survives the quiescent half of
# a suspend/resume oscillation so the attempt budget is reached, and is forgotten only once the
# suspend has held for _ZOMBIE_FORGET_TICKS.
_ZOMBIE_CONFIRM_TICKS = 2          # consecutive sightings before the first suspend
_ZOMBIE_SUSPEND_BACKOFF_TICKS = 3  # ticks to wait between suspends
_ZOMBIE_MAX_SUSPENDS = 3           # suspend attempts before the terminal escalation
_ZOMBIE_FORGET_TICKS = 12          # consecutive quiescent ticks before the attempt budget is forgotten

# A drift that keeps recurring (an alternating ping-pong included) warns at most this often.
_DRIFT_WARN_COOLDOWN_S = 600.0


@dataclass
class _ZombieProgress:
    confirms: int = 0       # consecutive ticks reconcile flagged this conversation as a zombie
    suspends: int = 0       # suspend patches issued so far
    cooldown: int = 0       # ticks remaining before the next suspend is allowed
    resolved: bool = False  # terminal escalation done and logged once; take no further action
    quiescent: int = 0      # consecutive ticks the suspend has held


_zombie_progress: dict[str, _ZombieProgress] = {}

# Last tick's generations: a fresh claim gets one tick's grace.
_prev_gen: dict[str, int] = {}

# A revive cycling the pod suspends the Sandbox under its owner.
_DRIFT_REVIVE_GRACE_S = 300.0
_drift_since: dict[str, float] = {}  # conversation -> when drift on a Ready host was first seen
_now = time.monotonic


def reconcile_once(k8s, cap: int, rows) -> list[tuple[str, str]]:
    """One reconcile pass over all Conversations, returning [(name, action_kind)]; load is tracked as assignments are made so a burst of Pending conversations spreads across pods."""
    pods = k8s.list_host_pods()
    # A terminating pod still reports Ready through its grace period, so exclude it here.
    ready_names = {p.name for p in pods if p.ready and not p.terminating}
    # Sandbox listing is best-effort: without it there is no evidence and no drift repair this tick.
    try:
        sandbox_modes = {sb.name: sb.operating_mode for sb in k8s.list_sandboxes()}
    except Exception:  # noqa: BLE001
        logger.warning(
            "list_sandboxes failed", extra={**_C, "skipped": "drift-repair"}, exc_info=True
        )
        sandbox_modes = {}
    running = {ref for ref, mode in sandbox_modes.items() if mode != "Suspended"}
    states = rows.list_states(running, set(_zombie_progress))
    if states is None:
        logger.warning("skipping reconcile: conversations rows unreadable", extra=_C)
        return []
    ip_of = {p.name: p.ip for p in pods}
    convs = [_row_state(r, sandbox_modes, ip_of) for r in states]

    # Seed load from conversations currently assigned to a still-ready pod.
    load: dict[str, int] = {}
    for c in convs:
        if c.host_pod is not None and c.host_pod in ready_names:
            load[c.host_pod] = load.get(c.host_pod, 0) + 1

    # Current host per conversation so a subagent can co-locate on its parent; parents sort first
    # so a child sees its parent's fresh assignment.
    hosts: dict[str, str | None] = {c.name: c.host_pod for c in convs}
    convs.sort(key=lambda c: c.parent_id is not None)

    results: list[tuple[str, str]] = []
    zombie_flagged: set[str] = set()
    drifting_on_ready: set[str] = set()
    for c in convs:
        action = reconcile(c, pods, load, cap, hosts)
        if isinstance(action, NoOp):
            results.append((c.name, "noop"))
            continue
        if isinstance(action, SuspendSandbox):
            zombie_flagged.add(c.name)
            prog = _zombie_progress.setdefault(c.name, _ZombieProgress())

            if prog.resolved:
                results.append((c.name, "zombie-resolved"))
                continue

            prog.confirms += 1

            # A single sighting can be a revive mid-flight, so it is only a suspect.
            if prog.confirms < _ZOMBIE_CONFIRM_TICKS:
                logger.info(
                    "zombie sandbox suspect — confirming next tick",
                    extra={**_C, "conversation_id": c.name, "sandbox": c.sandbox_ref or ""},
                )
                results.append((c.name, "suspend-sandbox-suspect"))
                continue

            if prog.cooldown > 0:
                prog.cooldown -= 1
                results.append((c.name, "suspend-sandbox-backoff"))
                continue

            # Only the pod is reclaimed; deleting the Sandbox CR would cascade the workspace PVC.
            if prog.suspends >= _ZOMBIE_MAX_SUSPENDS:
                if c.sandbox_ref:
                    k8s.reclaim_sandbox_pod(c.sandbox_ref)
                rows.set_phase(c.name, "Failed")
                prog.resolved = True
                logger.error(
                    "zombie sandbox unresolved — escalating (reclaim the leaked pod + mark conversation Failed)",
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
            # Release stale placement on a suspended conversation.
            rows.release_assignment(c.name, c.generation)
            hosts[c.name] = None
            results.append((c.name, "detach"))
            continue
        if isinstance(action, MarkSuspended) and _prev_gen.get(c.name) != c.generation:
            results.append((c.name, "drift-grace"))
            continue
        if isinstance(action, MarkSuspended) and c.host_pod in ready_names:
            drifting_on_ready.add(c.name)
            since = _drift_since.setdefault(c.name, _now())
            if _now() - since < _DRIFT_REVIVE_GRACE_S:
                results.append((c.name, "drift-revive-grace"))
                continue
        if isinstance(action, MarkSuspended):
            # The Sandbox is Suspended but the phase is not: fix the phase and release placement,
            # de-duplicating only the log.
            warn_once(
                logger,
                f"phase-drift:{c.name}",
                "phase drift repaired",
                {**_C, "conversation_id": c.name, "reason": action.reason},
                cooldown_s=_DRIFT_WARN_COOLDOWN_S,
            )
            rows.set_phase(c.name, "Suspended")
            rows.release_assignment(c.name, c.generation)
            hosts[c.name] = None
            results.append((c.name, "mark-suspended"))
            continue
        if isinstance(action, LeavePending):
            # Write unless the row already says {phase: Pending, host_pod: null}; a row with no
            # phase is written so its phase materializes.
            if c.host_pod is not None or not c.phase_present or c.phase != "Pending":
                rows.set_phase(c.name, "Pending")
                rows.release_assignment(c.name, c.generation)
            hosts[c.name] = None
            results.append((c.name, "pending"))
            continue
        # Assign / Reassign.
        assert isinstance(action, Assign)
        # The row claim decides; losing to the router is fine.
        if not rows.set_assignment(c.name, action.host_pod, action.generation):
            results.append((c.name, "assign-lost"))
            continue
        rows.set_phase(c.name, action.phase)
        hosts[c.name] = action.host_pod
        # A subagent shares its parent's pod, so it does not count toward pod capacity.
        if c.parent_id is None:
            load[action.host_pod] = load.get(action.host_pod, 0) + 1
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
        # Fire-and-forget revive push so the host hydrates before user traffic arrives; a pod
        # without an IP yet is pushed on the next tick.
        if action.host_ip:
            try:
                k8s.notify_revive(action.host_ip, c.name, action.generation)
            except Exception:  # noqa: BLE001
                logger.warning(
                    "revive-push spawn failed",
                    extra={**_C, "conversation_id": c.name, "fallback": "lazy-revive"},
                    exc_info=True,
                )

    # A conversation that left the zombie state drops its record; one that is merely quiescent
    # (its suspend landed) keeps its attempt budget until the suspend has held long enough.
    quiescent = {
        c.name
        for c in convs
        if c.phase == "Suspended"
        and c.host_pod is None
        and c.sandbox_mode == "Suspended"
    }
    for name, prog in list(_zombie_progress.items()):
        if name in zombie_flagged:
            prog.quiescent = 0
            continue
        if name not in quiescent:
            del _zombie_progress[name]
            continue
        prog.confirms = 0
        prog.quiescent += 1
        if prog.quiescent >= _ZOMBIE_FORGET_TICKS:
            del _zombie_progress[name]

    for name in list(_drift_since):
        if name not in drifting_on_ready:
            del _drift_since[name]

    _prev_gen.clear()
    _prev_gen.update({c.name: c.generation for c in convs})

    expire_warned(_DRIFT_WARN_COOLDOWN_S)

    return results


class AutoscaleState:
    """Mutable cooldown state the caller owns across ticks (scale-down hysteresis)."""

    def __init__(self) -> None:
        self.last_scale_down: float = 0.0


def autoscale_once(k8s, cfg, state: AutoscaleState, now: float, rows) -> dict:
    """Scale the agent-host Deployment to fit conversation demand and return {demand, current, target, ready_pods, per_pod}; the controller is the only writer of spec.replicas, so no HPA may run alongside it."""
    live = rows.list_live()
    if live is None:
        # Scaling on a demand of zero would drain the fleet.
        raise RuntimeError("conversations rows unreadable; autoscale skipped")
    convs = [_row_state(r, {}, {}) for r in live]
    # Demand counts top-level Pending and Assigned conversations only.
    demand = demand_of(convs)
    pods = k8s.list_host_pods()
    ready_pods = sum(1 for p in pods if p.ready)
    current = k8s.get_agent_host_replicas()

    # Pods hosting live conversations must carry their deletion cost before a scale-down picks
    # victims; patch only on change.
    for pod_name, cost in deletion_costs(pods, convs).items():
        if next((p.deletion_cost for p in pods if p.name == pod_name), None) != cost:
            try:
                k8s.set_pod_deletion_cost(pod_name, cost)
            except Exception:  # noqa: BLE001
                logger.warning("set_pod_deletion_cost failed", extra={**_C, "pod": pod_name}, exc_info=True)

    target = desired_replicas(demand, cfg.pod_cap, cfg.min_replicas, cfg.max_replicas)
    per_pod = (demand / ready_pods) if ready_pods else float(demand)

    if target > current:
        # Scale up immediately, since a Pending conversation is a user waiting for a slot.
        k8s.set_agent_host_replicas(target)
        logger.info(
            "autoscale up",
            extra={**_C, "from_replicas": current, "to_replicas": target, "demand": demand, "pod_cap": cfg.pod_cap},
        )
    elif target < current:
        # Scale down only after the cooldown so a brief dip does not drop a pod.
        if now - state.last_scale_down >= cfg.scale_down_cooldown_seconds:
            k8s.set_agent_host_replicas(target)
            state.last_scale_down = now
            logger.info(
                "autoscale down",
                extra={**_C, "from_replicas": current, "to_replicas": target, "demand": demand, "pod_cap": cfg.pod_cap},
            )

    return {"demand": demand, "current": current, "target": target, "ready_pods": ready_pods, "per_pod": per_pod}


def reap_overlays(k8s, retention_seconds: float) -> list[str]:
    """Delete overlay PVCs suspended past retention; resume recreates them."""
    expired = find_expired_overlays(k8s.list_sandboxes(), k8s.list_pvc_names(), retention_seconds)
    reaped: list[str] = []
    for name in expired:
        try:
            k8s.delete_pvc(name)
            reaped.append(name)
            logger.info("reaped expired overlay store", extra={**_C, "pvc": name})
        except Exception:  # noqa: BLE001
            logger.exception("overlay reap failed", extra={**_C, "pvc": name, "will_retry_next_pass": True})
    return reaped


# Bounds one pass so a first rollout drains a backlog gradually.
SANDBOX_REAP_BATCH = 20


def reap_sandboxes(k8s, rows, retention_seconds: float, now_ms: int) -> list[str]:
    """Delete idle suspended sandboxes and both their PVCs; the conversations stay."""
    if retention_seconds <= 0:
        return []
    cutoff = now_ms - int(retention_seconds * 1000)
    reapable = rows.reapable_sandboxes(cutoff)
    if reapable is None:
        logger.warning("skipping sandbox reap: conversations rows unreadable", extra=_C)
        return []
    expired = find_expired_sandboxes(k8s.list_sandboxes(), reapable, retention_seconds)
    reaped: list[str] = []
    for name in expired[:SANDBOX_REAP_BATCH]:
        # A message may have revived it since the batch read.
        if name not in (rows.reapable_sandboxes(cutoff, only=name) or set()):
            continue
        try:
            k8s.delete_sandbox_tree(name)
            k8s.delete_pvc(f"scooter-rw-{name}")
            k8s.delete_pvc(f"workspace-{name}")
            reaped.append(name)
            logger.info("reaped idle sandbox", extra={**_C, "sandbox_name": name})
        except Exception:  # noqa: BLE001
            logger.exception("sandbox reap failed", extra={**_C, "sandbox_name": name, "will_retry_next_pass": True})
    return reaped


def reap_orphans(k8s, grace_seconds: float, rows) -> list[str]:
    """One reaper pass: delete the whole tree (Sandbox, ServiceAccount, module ConfigMap) of every Sandbox no conversation references that is older than the grace window, and return the reaped names."""
    sandboxes = k8s.list_sandboxes()
    row_refs = rows.referenced_sandboxes()
    # A wrong or empty "referenced" set deletes live sandboxes, so doubt means skip the pass.
    if row_refs is None:
        logger.warning("skipping orphan reap: conversations rows unreadable", extra=_C)
        return []
    if not row_refs and sandboxes:
        logger.warning(
            "skipping orphan reap: no row references a sandbox but sandboxes exist",
            extra={**_C, "sandboxes": len(sandboxes)},
        )
        return []
    orphans = find_orphans(sandboxes, row_refs, grace_seconds)
    reaped: list[str] = []
    for name in orphans:
        try:
            k8s.delete_sandbox_tree(name)
            reaped.append(name)
            logger.info(
                "reaped orphaned sandbox", extra={**_C, "sandbox_name": name, "reason": "no owning Conversation"}
            )
        except Exception:  # noqa: BLE001

            logger.exception(
                "reap of orphaned sandbox failed",
                extra={**_C, "sandbox_name": name, "will_retry_next_pass": True},
            )
    return reaped
