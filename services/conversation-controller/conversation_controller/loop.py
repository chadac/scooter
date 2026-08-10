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
    return ConversationState(
        name=cr["metadata"]["name"],
        host_pod=st.get("hostPod"),
        phase=st.get("phase", "Pending"),
        generation=int(st.get("generation", 0)),
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

    results: list[tuple[str, str]] = []
    for c in convs:
        action = reconcile(c, pods, load, cap)
        if isinstance(action, NoOp):
            results.append((c.name, "noop"))
            continue
        if isinstance(action, LeavePending):
            # Only patch if it isn't already Pending/host-cleared (avoid churn).
            if c.host_pod is not None or c.phase != "Pending":
                k8s.patch_status(c.name, {"phase": "Pending", "hostPod": None})
            results.append((c.name, "pending"))
            continue
        # Assign / Reassign.
        assert isinstance(action, Assign)
        k8s.patch_status(c.name, {
            "phase": action.phase,
            "hostPod": action.host_pod,
            "generation": action.generation,
        })
        load[action.host_pod] = load.get(action.host_pod, 0) + 1  # count it for the rest of this pass
        results.append((c.name, "assign"))
        logger.info("assigned %s -> %s (gen %d)", c.name, action.host_pod, action.generation)
    return results
