"""The reconcile LOOP — the imperative shell around reconcile.py. Lists pods +
Conversations, computes per-pod load, decides each conversation's action, applies the
status patch. Leader-gated by the caller (only the Lease holder runs reconcile_once).

Kept free of I/O DETAILS: it takes a ControllerK8s (real or fake), so the whole loop is
unit-testable against an in-memory fake (see test_loop.py)."""

from __future__ import annotations

import logging

from .reconcile import ConversationState, Assign, NoOp, LeavePending, reconcile

logger = logging.getLogger("conversation-controller")


def _state(cr: dict) -> ConversationState:
    st = cr.get("status") or {}
    spec = cr.get("spec") or {}
    return ConversationState(
        name=cr["metadata"]["name"],
        host_pod=st.get("hostPod"),
        phase=st.get("phase", "Pending"),
        # Whether the CR actually carries a phase (vs. the "Pending" default above). A
        # status-less CR (status: null / no phase) needs its phase MATERIALIZED even when it
        # stays Pending — see the LeavePending branch.
        phase_present=st.get("phase") is not None,
        generation=int(st.get("generation", 0)),
        host_ip=st.get("hostIP"),
        parent_id=spec.get("parentId"),
    )


def reconcile_once(k8s, cap: int) -> list[tuple[str, str]]:
    """One reconcile pass over all Conversations. Returns [(name, action_kind)] for
    logging/tests. Only mutates via k8s.patch_status. The LOAD each conversation sees
    already excludes conversations that are being (re)assigned this pass — we compute it
    from the CURRENT status and update it as we assign, so a burst of Pending
    conversations spreads across pods instead of all landing on the least-loaded one."""
    pods = k8s.list_host_pods()
    ready_names = {p.name for p in pods if p.ready}
    convs = [_state(cr) for cr in k8s.list_conversations()]

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
    for c in convs:
        action = reconcile(c, pods, load, cap, hosts)
        if isinstance(action, NoOp):
            results.append((c.name, "noop"))
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
        logger.info("assigned %s -> %s @ %s (gen %d)", c.name, action.host_pod, action.host_ip, action.generation)
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
                logger.warning("revive-push spawn for %s failed (will rely on lazy revive)", c.name)
    return results
