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
)


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


def conv(host=None, phase="Pending", gen=0) -> ConversationState:
    return ConversationState(name="c1", host_pod=host, phase=phase, generation=gen)


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
