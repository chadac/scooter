"""Tier 1 — the pure reconcile core (no k8s). Locks the assignment decisions."""

from conversation_controller.reconcile import (
    Pod,
    ConversationState,
    NoOp,
    Assign,
    LeavePending,
    SandboxRef,
    pick_host,
    reconcile,
    find_orphans,
    desired_replicas,
    demand_of,
    Detach,
    SuspendSandbox,
)


# --- reconcile RESPECTS the Suspended phase (needs no pod) -------------------

def test_suspended_with_stale_host_is_detached():
    # A conversation the host suspended (phase=Suspended) still carries its old hostPod
    # (suspend() writes phase, not hostPod). The controller RELEASES the host — a suspended
    # conversation needs no pod. Without this, when that pod dies reconcile would RE-ASSIGN it
    # (clobbering Suspended → Assigned) and it'd re-count as demand → the fleet never sleeps.
    a = reconcile(conv(host="a", phase="Suspended", gen=1), [Pod("a", True)], {"a": 1}, cap=10)
    assert isinstance(a, Detach)


def test_suspended_with_no_host_is_noop():
    # Fully clean ({Suspended, hostPod: null, hostIP: null}) → nothing to do (no churn).
    a = reconcile(conv(host=None, phase="Suspended", gen=1), [Pod("a", True)], {}, cap=10)
    assert isinstance(a, NoOp)


def test_suspended_with_stale_hostip_but_no_hostpod_is_detached():
    # THE stale-hostIP bug (docs/scooter-bug-stale-hostip-routes-to-dead-pod.md): after a
    # rollout the suspended conversation has hostPod cleared but a STALE hostIP still pointing
    # at the deleted pod. The router dials that dead IP forever. reconcile must treat a lingering
    # hostIP (even with no hostPod) as a state to REPAIR — Detach so loop clears hostIP — not a
    # NoOp that leaves the dead address in place. The invariant: hostIP is empty whenever hostPod
    # is empty (they name the same owner).
    a = reconcile(
        conv(host=None, phase="Suspended", gen=2, host_ip="10.1.4.35"),
        [Pod("a", True)],
        {},
        cap=10,
    )
    assert isinstance(a, Detach)


def test_suspended_never_reassigned_even_when_host_gone():
    # The stuck case: a suspended conversation whose host pod is GONE must NOT be reassigned
    # (that's what re-woke it as demand). It's detached (host released), not Assigned/Pending.
    a = reconcile(conv(host="dead-pod", phase="Suspended", gen=1), [Pod("b", True)], {"b": 0}, cap=10)
    assert isinstance(a, Detach)


def _cs(name, phase="Assigned", host: str | None = "p1", parent=None):
    return ConversationState(
        name=name, host_pod=host, phase=phase, generation=1, parent_id=parent
    )


# --- demand_of (the autoscale demand — Suspended conversations DON'T count) -----

def test_demand_counts_assigned_and_pending_but_not_suspended():
    convs = [
        _cs("a", phase="Assigned"),
        _cs("b", phase="Pending", host=None),
        _cs("c", phase="Suspended", host=None),   # idle — no pod needed
        _cs("d", phase="Suspended", host=None),
    ]
    # Only a + b need a pod; the two Suspended don't (they revive on demand).
    assert demand_of(convs) == 2


def test_demand_all_suspended_is_zero():
    # The bug: idle conversations kept the fleet pinned. All-suspended → zero demand →
    # the autoscaler can scale down to the min floor (the pods finally sleep).
    convs = [_cs("a", phase="Suspended", host=None), _cs("b", phase="Suspended", host=None)]
    assert demand_of(convs) == 0


def test_demand_excludes_subagents():
    # A subagent co-locates on its parent's pod — no independent capacity.
    convs = [_cs("parent", phase="Assigned"), _cs("child", phase="Assigned", parent="parent")]
    assert demand_of(convs) == 1


def test_demand_empty_is_zero():
    assert demand_of([]) == 0


# --- desired_replicas (the autoscaler decision) ----------------------------

def test_desired_rounds_up_to_fit_demand():
    # 3 conversations @ cap 2 -> 2 pods (never leave a conversation without a slot).
    assert desired_replicas(demand=3, cap=2, min_replicas=1, max_replicas=10) == 2
    assert desired_replicas(demand=4, cap=2, min_replicas=1, max_replicas=10) == 2
    assert desired_replicas(demand=5, cap=2, min_replicas=1, max_replicas=10) == 3


def test_desired_respects_min_floor():
    # No demand -> the min floor (never scale to 0; keep a warm fleet).
    assert desired_replicas(demand=0, cap=1, min_replicas=2, max_replicas=10) == 2
    # A tiny demand still can't drop below min.
    assert desired_replicas(demand=1, cap=100, min_replicas=2, max_replicas=10) == 2


def test_desired_clamps_to_max():
    assert desired_replicas(demand=1000, cap=1, min_replicas=2, max_replicas=10) == 10


def test_desired_cap_one_is_replicas_equals_demand():
    # cap=1 (the odin test config) -> one pod per conversation, clamped to [min,max].
    assert desired_replicas(demand=5, cap=1, min_replicas=2, max_replicas=10) == 5


def test_desired_defends_against_zero_cap():
    # A misconfigured cap<1 is treated as 1 (never divide by zero / infinite pods).
    assert desired_replicas(demand=3, cap=0, min_replicas=1, max_replicas=10) == 3


# --- find_orphans (the reaper decision) ------------------------------------

def test_orphan_is_unreferenced_and_past_grace():
    sbs = [SandboxRef("conv-a", age_seconds=1000), SandboxRef("conv-b", age_seconds=1000)]
    # conv-a is referenced (kept); conv-b is not (reaped).
    assert find_orphans(sbs, referenced={"conv-a"}, grace_seconds=600) == ["conv-b"]


def test_young_unreferenced_sandbox_is_spared_by_grace():
    # A just-created Sandbox whose Conversation CR isn't registered yet — spare it.
    sbs = [SandboxRef("conv-new", age_seconds=30)]
    assert find_orphans(sbs, referenced=set(), grace_seconds=600) == []


def test_old_unreferenced_sandbox_at_grace_boundary_is_reaped():
    sbs = [SandboxRef("conv-x", age_seconds=600)]  # exactly at the window
    assert find_orphans(sbs, referenced=set(), grace_seconds=600) == ["conv-x"]


def test_referenced_sandbox_never_reaped_regardless_of_age():
    sbs = [SandboxRef("conv-a", age_seconds=999999)]
    assert find_orphans(sbs, referenced={"conv-a"}, grace_seconds=600) == []


def test_no_sandboxes_no_orphans():
    assert find_orphans([], referenced=set(), grace_seconds=600) == []


def conv(host=None, phase="Pending", gen=0, host_ip=None, sandbox_mode=None) -> ConversationState:
    return ConversationState(
        name="c1", host_pod=host, phase=phase, generation=gen, host_ip=host_ip,
        sandbox_mode=sandbox_mode,
    )


# --- pick_host --------------------------------------------------------------

def test_pick_least_loaded_ready_pod():
    pods = [Pod("a", True), Pod("b", True)]
    assert pick_host(pods, {"a": 3, "b": 1}, cap=10) == "b"


def test_pick_skips_not_ready():
    pods = [Pod("a", False), Pod("b", True)]
    assert pick_host(pods, {"a": 0, "b": 5}, cap=10) == "b"


def test_pick_skips_pods_at_cap():
    pods = [Pod("a", True), Pod("b", True)]
    assert pick_host(pods, {"a": 10, "b": 10}, cap=10) is None  # both full
    assert pick_host(pods, {"a": 10, "b": 9}, cap=10) == "b"


def test_pick_tie_break_by_name_is_stable():
    pods = [Pod("b", True), Pod("a", True)]
    assert pick_host(pods, {"a": 2, "b": 2}, cap=10) == "a"  # equal load -> lowest name


def test_pick_none_when_no_ready_pods():
    assert pick_host([Pod("a", False)], {}, cap=10) is None


# --- reconcile --------------------------------------------------------------

def test_assigns_a_pending_conversation_and_bumps_generation():
    a = reconcile(conv(host=None, gen=0), [Pod("a", True)], {}, cap=10)
    assert isinstance(a, Assign)
    assert a.host_pod == "a"
    assert a.generation == 1          # gen bumped
    assert a.phase == "Assigned"


def test_assign_carries_the_chosen_pods_ip():
    # The routing address (pod IP) rides along on the Assign so loop.py can patch hostIP.
    a = reconcile(conv(host=None, gen=0), [Pod("a", True, ip="10.42.0.7")], {}, cap=10)
    assert isinstance(a, Assign)
    assert a.host_pod == "a"
    assert a.host_ip == "10.42.0.7"


def test_noop_when_host_still_ready():
    a = reconcile(conv(host="a", phase="Assigned", gen=1), [Pod("a", True)], {"a": 1}, cap=10)
    assert isinstance(a, NoOp)


def test_reassigns_when_host_gone_and_bumps_generation():
    # host "a" is no longer in the pod list -> reassign to "b", gen bumps.
    a = reconcile(conv(host="a", phase="Assigned", gen=1), [Pod("b", True)], {"b": 0}, cap=10)
    assert isinstance(a, Assign)
    assert a.host_pod == "b"
    assert a.generation == 2


def test_reassigns_when_host_present_but_not_ready():
    a = reconcile(conv(host="a", phase="Assigned", gen=1), [Pod("a", False), Pod("b", True)], {"b": 0}, cap=10)
    assert isinstance(a, Assign)
    assert a.host_pod == "b"


def test_leaves_pending_when_all_pods_at_cap():
    a = reconcile(conv(host=None, gen=0), [Pod("a", True)], {"a": 10}, cap=10)
    assert isinstance(a, LeavePending)


def test_leaves_pending_when_no_ready_pods():
    a = reconcile(conv(host=None, gen=0), [Pod("a", False)], {}, cap=10)
    assert isinstance(a, LeavePending)


# --- subagent co-location (spec.parentId) -----------------------------------

def child(host=None, gen=0, parent="p1") -> ConversationState:
    return ConversationState(name="c-child", host_pod=host, phase="Pending", generation=gen, parent_id=parent)


def test_subagent_pins_to_parent_pod_ignoring_cap():
    # Parent p1 lives on pod "a", which is AT cap — the child must still land on "a"
    # (it shares the parent's pod, so cap doesn't apply).
    a = reconcile(child(), [Pod("a", True)], {"a": 10}, cap=10, hosts={"p1": "a"})
    assert isinstance(a, Assign)
    assert a.host_pod == "a"
    assert a.generation == 1


def test_subagent_pending_when_parent_unassigned():
    a = reconcile(child(), [Pod("a", True)], {}, cap=10, hosts={"p1": None})
    assert isinstance(a, LeavePending)


def test_subagent_pending_when_parent_pod_not_ready():
    a = reconcile(child(), [Pod("a", False)], {}, cap=10, hosts={"p1": "a"})
    assert isinstance(a, LeavePending)


def test_subagent_noop_when_already_colocated():
    a = reconcile(child(host="a", gen=1), [Pod("a", True)], {"a": 1}, cap=10, hosts={"p1": "a"})
    assert isinstance(a, NoOp)


def test_subagent_re_pins_when_parent_moved():
    # Parent reassigned to "b"; the child was on "a" → follow the parent to "b".
    a = reconcile(child(host="a", gen=1), [Pod("a", True), Pod("b", True)], {}, cap=10, hosts={"p1": "b"})
    assert isinstance(a, Assign)
    assert a.host_pod == "b"
    assert a.generation == 2


# --- phase ⇄ sandbox drift reconcile (todo/docs/CONVERSATION_PHASE_DRIFT_RECONCILE.md) ---
#
# THE DRIFT, observed live twice (2026-08-12 and 2026-08-22): a CR sits at phase=Assigned while
# its backing Sandbox is operatingMode=Suspended. The host's setPhase("Suspended") is
# owner-fenced, so any suspend not driven by the CR's owner (another pod's sweep, agent-sandbox's
# own idle timer, an owner that died mid-suspend) never publishes — and the controller then keeps
# the phantom in the autoscale demand forever ("14 conversations Assigned, node full, nothing
# running"). The Sandbox is the truth for alive/suspended; the controller reconciles phase to it.

from conversation_controller.reconcile import MarkSuspended


def test_assigned_but_sandbox_suspended_is_marked_suspended():
    a = reconcile(
        conv(host="a", phase="Assigned", gen=1, sandbox_mode="Suspended"),
        [Pod("a", True)], {"a": 1}, cap=10,
    )
    assert isinstance(a, MarkSuspended)


def test_pending_but_sandbox_suspended_is_marked_suspended():
    # The 2026-08-12 case: a raw-API conversation never got a real owner, its sandbox
    # idle-suspended on its own, and the CR sat at Pending forever.
    a = reconcile(
        conv(phase="Pending", sandbox_mode="Suspended"),
        [Pod("a", True)], {}, cap=10,
    )
    assert isinstance(a, MarkSuspended)


def test_assigned_with_running_sandbox_is_untouched():
    a = reconcile(
        conv(host="a", phase="Assigned", gen=1, sandbox_mode="Running"),
        [Pod("a", True)], {"a": 1}, cap=10,
    )
    assert isinstance(a, NoOp)


def test_absent_sandbox_is_NOT_marked_suspended():
    # CREATION RACE guard: start() registers the CR before the provisioner creates the
    # Sandbox. A tick landing in that window sees sandbox=absent on a genuinely-live new
    # conversation; stomping it to Suspended would break the conversation as it is being
    # born. Absence is NOT evidence of suspension — only an existing Suspended sandbox is.
    a = reconcile(
        conv(host="a", phase="Assigned", gen=1, sandbox_mode=None),
        [Pod("a", True)], {"a": 1}, cap=10,
    )
    assert isinstance(a, NoOp)


def test_already_suspended_keeps_the_detach_path():
    # phase=Suspended + sandbox Suspended is the CONSISTENT state — the existing Detach/NoOp
    # logic owns it; the drift rule must not fire.
    a = reconcile(
        conv(host="a", phase="Suspended", gen=1, sandbox_mode="Suspended"),
        [Pod("a", True)], {"a": 1}, cap=10,
    )
    assert isinstance(a, Detach)


def test_mark_suspended_takes_a_phantom_out_of_demand():
    # The user-visible consequence: after the controller applies MarkSuspended, the
    # conversation stops counting toward the autoscale demand, so the fleet can shrink.
    phantom = conv(host="a", phase="Assigned", gen=1, sandbox_mode="Suspended")
    assert demand_of([phantom]) == 1  # counted while drifted — the bug
    healed = ConversationState(
        name="c1", host_pod=None, phase="Suspended", generation=1
    )
    assert demand_of([healed]) == 0


# --- zombie sandboxes ---------------------------------------------------------
#
# Observed on valhalla: three sandbox pods running 9-12h, conversations
# phase=Suspended host=<none>. A racing sweeper's exec probe resumed a
# just-suspended sandbox; every host then evicted the conversation, so no sweep
# will ever visit it again — "the sweep reclaims it either way" is structurally
# unreachable for this state. The controller is the only actor left.

def test_suspended_unhosted_running_sandbox_is_a_zombie():
    a = reconcile(conv(host=None, phase="Suspended", gen=1, sandbox_mode="Running"),
                  [Pod("a", True)], {}, cap=10)
    assert isinstance(a, SuspendSandbox)


def test_suspended_with_host_detaches_first_even_if_sandbox_runs():
    # Placement release comes first; the zombie check re-fires next tick once unhosted.
    a = reconcile(conv(host="a", phase="Suspended", gen=1, sandbox_mode="Running"),
                  [Pod("a", True)], {"a": 1}, cap=10)
    assert isinstance(a, Detach)


def test_suspended_with_suspended_or_absent_sandbox_stays_noop():
    for mode in ("Suspended", None):
        a = reconcile(conv(host=None, phase="Suspended", gen=1, sandbox_mode=mode),
                      [Pod("a", True)], {}, cap=10)
        assert isinstance(a, NoOp), f"sandbox_mode={mode}"
