"""Tier 1: the pure reconcile core, no k8s."""

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
    find_expired_overlays,
    find_expired_sandboxes,
    desired_replicas,
    demand_of,
    Detach,
    SuspendSandbox,
)


# --- reconcile respects the Suspended phase ---------------------------------

def test_suspended_with_stale_host_is_detached():
    a = reconcile(conv(host="a", phase="Suspended", gen=1), [Pod("a", True)], {"a": 1}, cap=10)
    assert isinstance(a, Detach)


def test_suspended_with_no_host_is_noop():
    a = reconcile(conv(host=None, phase="Suspended", gen=1), [Pod("a", True)], {}, cap=10)
    assert isinstance(a, NoOp)


def test_suspended_never_reassigned_even_when_host_gone():
    a = reconcile(conv(host="dead-pod", phase="Suspended", gen=1), [Pod("b", True)], {"b": 0}, cap=10)
    assert isinstance(a, Detach)


def _cs(name, phase="Assigned", host: str | None = "p1", parent=None):
    return ConversationState(
        name=name, host_pod=host, phase=phase, generation=1, parent_id=parent
    )


# --- demand_of (the autoscale demand) --------------------------------------

def test_demand_counts_assigned_and_pending_but_not_suspended():
    convs = [
        _cs("a", phase="Assigned"),
        _cs("b", phase="Pending", host=None),
        _cs("c", phase="Suspended", host=None),
        _cs("d", phase="Suspended", host=None),
    ]
    assert demand_of(convs) == 2


def test_demand_all_suspended_is_zero():
    convs = [_cs("a", phase="Suspended", host=None), _cs("b", phase="Suspended", host=None)]
    assert demand_of(convs) == 0


def test_demand_excludes_subagents():
    convs = [_cs("parent", phase="Assigned"), _cs("child", phase="Assigned", parent="parent")]
    assert demand_of(convs) == 1


def test_demand_empty_is_zero():
    assert demand_of([]) == 0


# --- desired_replicas (the autoscaler decision) ----------------------------

def test_desired_rounds_up_to_fit_demand():
    assert desired_replicas(demand=3, cap=2, min_replicas=1, max_replicas=10) == 2
    assert desired_replicas(demand=4, cap=2, min_replicas=1, max_replicas=10) == 2
    assert desired_replicas(demand=5, cap=2, min_replicas=1, max_replicas=10) == 3


def test_desired_respects_min_floor():
    assert desired_replicas(demand=0, cap=1, min_replicas=2, max_replicas=10) == 2
    assert desired_replicas(demand=1, cap=100, min_replicas=2, max_replicas=10) == 2


def test_desired_clamps_to_max():
    assert desired_replicas(demand=1000, cap=1, min_replicas=2, max_replicas=10) == 10


def test_desired_cap_one_is_replicas_equals_demand():
    assert desired_replicas(demand=5, cap=1, min_replicas=2, max_replicas=10) == 5


def test_desired_defends_against_zero_cap():
    assert desired_replicas(demand=3, cap=0, min_replicas=1, max_replicas=10) == 3


# --- find_orphans (the reaper decision) ------------------------------------

def test_orphan_is_unreferenced_and_past_grace():
    sbs = [SandboxRef("conv-a", age_seconds=1000), SandboxRef("conv-b", age_seconds=1000)]
    assert find_orphans(sbs, referenced={"conv-a"}, grace_seconds=600) == ["conv-b"]


def test_young_unreferenced_sandbox_is_spared_by_grace():
    sbs = [SandboxRef("conv-new", age_seconds=30)]
    assert find_orphans(sbs, referenced=set(), grace_seconds=600) == []


def test_old_unreferenced_sandbox_at_grace_boundary_is_reaped():
    sbs = [SandboxRef("conv-x", age_seconds=600)]
    assert find_orphans(sbs, referenced=set(), grace_seconds=600) == ["conv-x"]


def test_referenced_sandbox_never_reaped_regardless_of_age():
    sbs = [SandboxRef("conv-a", age_seconds=999999)]
    assert find_orphans(sbs, referenced={"conv-a"}, grace_seconds=600) == []


def test_no_sandboxes_no_orphans():
    assert find_orphans([], referenced=set(), grace_seconds=600) == []


def conv(host=None, phase="Pending", gen=0, host_ip=None, sandbox_mode=None, creator=None) -> ConversationState:
    return ConversationState(
        name="c1", host_pod=host, phase=phase, generation=gen, host_ip=host_ip,
        sandbox_mode=sandbox_mode, creator_pod=creator,
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
    assert pick_host(pods, {"a": 10, "b": 10}, cap=10) is None
    assert pick_host(pods, {"a": 10, "b": 9}, cap=10) == "b"


def test_pick_tie_break_by_name_is_stable():
    pods = [Pod("b", True), Pod("a", True)]
    assert pick_host(pods, {"a": 2, "b": 2}, cap=10) == "a"


def test_pick_none_when_no_ready_pods():
    assert pick_host([Pod("a", False)], {}, cap=10) is None


# --- reconcile --------------------------------------------------------------

def test_assigns_a_pending_conversation_and_bumps_generation():
    a = reconcile(conv(host=None, gen=0), [Pod("a", True)], {}, cap=10)
    assert isinstance(a, Assign)
    assert a.host_pod == "a"
    assert a.generation == 1
    assert a.phase == "Assigned"


def test_assign_carries_the_chosen_pods_ip():
    a = reconcile(conv(host=None, gen=0), [Pod("a", True, ip="10.42.0.7")], {}, cap=10)
    assert isinstance(a, Assign)
    assert a.host_pod == "a"
    assert a.host_ip == "10.42.0.7"


def test_noop_when_host_still_ready():
    a = reconcile(conv(host="a", phase="Assigned", gen=1), [Pod("a", True)], {"a": 1}, cap=10)
    assert isinstance(a, NoOp)


def test_reassigns_when_host_gone_and_bumps_generation():
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
    a = reconcile(child(host="a", gen=1), [Pod("a", True), Pod("b", True)], {}, cap=10, hosts={"p1": "b"})
    assert isinstance(a, Assign)
    assert a.host_pod == "b"
    assert a.generation == 2


# --- phase/sandbox drift reconcile ------------------------------------------
#
# A CR can sit at phase=Assigned while its Sandbox is Suspended; the Sandbox is the truth for
# alive/suspended, and the controller reconciles the phase to it.

from conversation_controller.reconcile import MarkSuspended


def test_assigned_but_sandbox_suspended_is_marked_suspended():
    a = reconcile(
        conv(host="a", phase="Assigned", gen=1, sandbox_mode="Suspended"),
        [Pod("a", True)], {"a": 1}, cap=10,
    )
    assert isinstance(a, MarkSuspended)


def test_pending_but_sandbox_suspended_is_marked_suspended():
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
    # The CR is registered before the Sandbox exists, so absence is not evidence of suspension.
    a = reconcile(
        conv(host="a", phase="Assigned", gen=1, sandbox_mode=None),
        [Pod("a", True)], {"a": 1}, cap=10,
    )
    assert isinstance(a, NoOp)


def test_already_suspended_keeps_the_detach_path():
    a = reconcile(
        conv(host="a", phase="Suspended", gen=1, sandbox_mode="Suspended"),
        [Pod("a", True)], {"a": 1}, cap=10,
    )
    assert isinstance(a, Detach)


def test_mark_suspended_takes_a_phantom_out_of_demand():
    phantom = conv(host="a", phase="Assigned", gen=1, sandbox_mode="Suspended")
    assert demand_of([phantom]) == 1
    healed = ConversationState(
        name="c1", host_pod=None, phase="Suspended", generation=1
    )
    assert demand_of([healed]) == 0


# --- zombie sandboxes ---------------------------------------------------------
#
# A Suspended, unhosted conversation whose Sandbox still runs will never be swept by a host
# again, so the controller is the only actor left.

def test_suspended_unhosted_running_sandbox_is_a_zombie():
    a = reconcile(conv(host=None, phase="Suspended", gen=1, sandbox_mode="Running"),
                  [Pod("a", True)], {}, cap=10)
    assert isinstance(a, SuspendSandbox)


def test_suspended_with_host_detaches_first_even_if_sandbox_runs():
    # Placement release comes first; the zombie check fires next tick once unhosted.
    a = reconcile(conv(host="a", phase="Suspended", gen=1, sandbox_mode="Running"),
                  [Pod("a", True)], {"a": 1}, cap=10)
    assert isinstance(a, Detach)


def test_suspended_with_suspended_or_absent_sandbox_stays_noop():
    for mode in ("Suspended", None):
        a = reconcile(conv(host=None, phase="Suspended", gen=1, sandbox_mode=mode),
                      [Pod("a", True)], {}, cap=10)
        assert isinstance(a, NoOp), f"sandbox_mode={mode}"

# --- creator-pod placement hint ---------------------------------------------
#
# The run physically lives on the pod that created the conversation, so a least-loaded pick
# that lands elsewhere splits the run from its owner.

def test_prefers_the_creator_pod_even_when_it_is_loaded():
    a = reconcile(conv(creator="a"), [Pod("a", True, ip="10.0.0.1"), Pod("b", True)],
                  {"a": 10, "b": 0}, cap=1)
    assert isinstance(a, Assign)
    assert a.host_pod == "a"
    assert a.host_ip == "10.0.0.1"


def test_falls_back_to_least_loaded_when_the_creator_is_gone():
    a = reconcile(conv(creator="dead"), [Pod("a", True), Pod("b", True)],
                  {"a": 3, "b": 1}, cap=10)
    assert isinstance(a, Assign)
    assert a.host_pod == "b"


def test_creator_hint_does_not_churn_an_existing_healthy_assignment():
    # A healthy assignment is not flapped back to the creator.
    a = reconcile(conv(host="b", phase="Assigned", gen=2, creator="a"),
                  [Pod("a", True), Pod("b", True)], {"a": 0, "b": 1}, cap=10)
    assert isinstance(a, NoOp)


# --- find_expired_overlays (the overlay retention decision) ------------------

DAY = 86400.0


def _sb(name, suspended_for=None, mode="Suspended"):
    return SandboxRef(name, age_seconds=99 * DAY, operating_mode=mode, suspended_seconds=suspended_for)


def test_overlay_of_a_long_suspended_sandbox_expires():
    sbs = [_sb("conv-old", 8 * DAY), _sb("conv-new", 1 * DAY)]
    pvcs = {"scooter-rw-conv-old", "scooter-rw-conv-new", "workspace-conv-old"}
    assert find_expired_overlays(sbs, pvcs, 7 * DAY) == ["scooter-rw-conv-old"]


def test_workspace_is_never_an_overlay():
    sbs = [_sb("conv-old", 30 * DAY)]
    assert find_expired_overlays(sbs, {"workspace-conv-old"}, 7 * DAY) == []


def test_a_running_sandbox_keeps_its_overlay():
    sbs = [_sb("conv-live", 30 * DAY, mode="Running")]
    assert find_expired_overlays(sbs, {"scooter-rw-conv-live"}, 7 * DAY) == []


def test_unknown_suspend_time_is_not_expired():
    sbs = [_sb("conv-x", None)]
    assert find_expired_overlays(sbs, {"scooter-rw-conv-x"}, 7 * DAY) == []


def test_zero_retention_disables_the_reaper():
    sbs = [_sb("conv-old", 365 * DAY)]
    assert find_expired_overlays(sbs, {"scooter-rw-conv-old"}, 0) == []


# --- find_expired_sandboxes (the whole-sandbox retention decision) ------------


def test_sandbox_suspended_past_retention_with_reapable_rows_expires():
    sbs = [_sb("conv-old", 8 * DAY), _sb("conv-new", 1 * DAY)]
    assert find_expired_sandboxes(sbs, {"conv-old", "conv-new"}, 7 * DAY) == ["conv-old"]


def test_sandbox_whose_rows_forbid_reaping_is_kept():
    assert find_expired_sandboxes([_sb("conv-starred", 30 * DAY)], set(), 7 * DAY) == []


def test_running_sandbox_is_never_expired():
    sbs = [_sb("conv-live", 30 * DAY, mode="Running")]
    assert find_expired_sandboxes(sbs, {"conv-live"}, 7 * DAY) == []


def test_sandbox_with_unknown_suspend_time_is_kept():
    assert find_expired_sandboxes([_sb("conv-x", None)], {"conv-x"}, 7 * DAY) == []


def test_zero_sandbox_retention_disables_the_reaper():
    assert find_expired_sandboxes([_sb("conv-old", 365 * DAY)], {"conv-old"}, 0) == []
