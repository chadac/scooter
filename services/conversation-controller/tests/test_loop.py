"""Tier 1 — the reconcile LOOP against a fake k8s (in-memory CRs + pods). No cluster."""

import pytest

import conversation_controller.loop as loop_mod
from conversation_controller.loop import reconcile_once, reap_orphans, autoscale_once, AutoscaleState
from conversation_controller.reconcile import Pod, SandboxRef


@pytest.fixture(autouse=True)
def _reset_zombie_state():
    """The zombie repair keeps module-level per-conversation state across ticks (one
    controller process, one loop). Reset it between tests so they don't leak. Tolerant of
    both the pre-fix `_zombie_suspects` set and the post-fix `_zombie_progress` dict."""
    for attr in ("_zombie_progress", "_zombie_suspects"):
        state = getattr(loop_mod, attr, None)
        if state is not None:
            state.clear()
    yield
    for attr in ("_zombie_progress", "_zombie_suspects"):
        state = getattr(loop_mod, attr, None)
        if state is not None:
            state.clear()


class FakeK8s:
    """In-memory Conversations + agent-host pods. patch_status merges into status."""

    def __init__(self, pods, convs, sandboxes=None, replicas=2):
        self._pods = pods                       # list[Pod]
        self._convs = {c["metadata"]["name"]: c for c in convs}
        self._sandboxes = {s.name: s for s in (sandboxes or [])}  # name -> SandboxRef
        self._replicas = replicas               # agent-host Deployment spec.replicas
        self.scale_calls = []                   # [replicas] each set_agent_host_replicas
        self.patches = []                       # [(name, status)] for assertions
        self.revives = []                       # [(host_ip, conv_name, generation)] revive-pushes
        self.deleted_trees = []                 # [sandbox_name] reaped
        self.cost_calls = []                    # [(pod, cost)] set_pod_deletion_cost
        self.suspends = []                      # [sandbox_name] suspend_sandbox calls (zombie repair)
        self.force_deleted = []                 # [sandbox_name] force_delete_sandbox calls (terminal)

    def set_pod_deletion_cost(self, name, cost):
        self.cost_calls.append((name, cost))

    def suspend_sandbox(self, name):
        self.suspends.append(name)

    def force_delete_sandbox(self, name):
        self.force_deleted.append(name)
        self._sandboxes.pop(name, None)

    def get_agent_host_replicas(self):
        return self._replicas

    def set_agent_host_replicas(self, n):
        self.scale_calls.append(n)
        self._replicas = n

    def list_host_pods(self):
        return list(self._pods)

    def list_conversations(self):
        return list(self._convs.values())

    def list_sandboxes(self):
        return list(self._sandboxes.values())

    def delete_sandbox_tree(self, name):
        self.deleted_trees.append(name)
        self._sandboxes.pop(name, None)

    def patch_status(self, name, status):
        self.patches.append((name, status))
        # Mirror the real status-subresource patch: a null/absent status materializes into
        # an object (the apiserver creates status on first patch — it's never left null).
        cur = self._convs[name].get("status")
        if cur is None:
            cur = {}
            self._convs[name]["status"] = cur
        cur.update({k: v for k, v in status.items()})

    def notify_revive(self, host_ip, conv_name, generation):
        self.revives.append((host_ip, conv_name, generation))

    # test helpers
    def status(self, name):
        return self._convs[name].get("status", {})


def _cr(name, host=None, phase="Pending", gen=0, parent=None, sandbox_ref=None, host_ip=None):
    st = {"phase": phase, "generation": gen}
    if host is not None:
        st["hostPod"] = host
    if host_ip is not None:
        st["hostIP"] = host_ip
    spec = {}
    if parent is not None:
        spec["parentId"] = parent
    if sandbox_ref is not None:
        spec["sandboxRef"] = sandbox_ref
    return {"metadata": {"name": name}, "spec": spec, "status": st}


# --- the orphan reaper loop -------------------------------------------------

def test_reap_deletes_unreferenced_sandbox_past_grace():
    # conv-a is referenced by a Conversation; conv-orphan is not → reap conv-orphan only.
    convs = [_cr("c1", sandbox_ref="conv-a")]
    sbs = [SandboxRef("conv-a", age_seconds=1000), SandboxRef("conv-orphan", age_seconds=1000)]
    k = FakeK8s([], convs, sandboxes=sbs)
    reaped = reap_orphans(k, grace_seconds=600)
    assert reaped == ["conv-orphan"]
    assert k.deleted_trees == ["conv-orphan"]


def test_reap_spares_young_orphan():
    k = FakeK8s([], [], sandboxes=[SandboxRef("conv-new", age_seconds=10)])
    assert reap_orphans(k, grace_seconds=600) == []
    assert k.deleted_trees == []


def test_reap_spares_referenced_sandbox():
    convs = [_cr("c1", sandbox_ref="conv-a")]
    k = FakeK8s([], convs, sandboxes=[SandboxRef("conv-a", age_seconds=99999)])
    assert reap_orphans(k, grace_seconds=600) == []


def test_reap_one_failure_does_not_abort_the_pass():
    class Boom(FakeK8s):
        def delete_sandbox_tree(self, name):
            if name == "conv-bad":
                raise RuntimeError("boom")
            super().delete_sandbox_tree(name)

    sbs = [SandboxRef("conv-bad", age_seconds=1000), SandboxRef("conv-good", age_seconds=1000)]
    k = Boom([], [], sandboxes=sbs)
    reaped = reap_orphans(k, grace_seconds=600)
    # conv-bad raised; conv-good still reaped.
    assert "conv-good" in k.deleted_trees
    assert reaped == ["conv-good"]


def test_pending_conversation_gets_a_host():
    k = FakeK8s([Pod("a", True)], [_cr("c1")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostPod"] == "a"
    assert k.status("c1")["phase"] == "Assigned"
    assert k.status("c1")["generation"] == 1


def test_statusless_cr_unassignable_materializes_pending():
    # REGRESSION (found live on odin): a brand-new CR with status: null that can't be
    # assigned (no pod / all at cap) was left at status:null forever — _state defaults
    # phase to "Pending", so the LeavePending branch thought it was ALREADY Pending and
    # skipped the patch → empty phase in the UI. It must materialize {phase: Pending}.
    cr = {"metadata": {"name": "cnew"}, "spec": {}, "status": None}  # status: null
    k = FakeK8s([], [cr])  # no ready pods → unassignable
    reconcile_once(k, cap=1)
    assert k.status("cnew").get("phase") == "Pending", "status:null CR must get phase materialized"


def test_already_pending_no_host_is_not_rechurned():
    # The complement: a CR that ALREADY says {phase: Pending, hostPod: null} and still can't
    # be assigned must NOT be re-patched every tick (avoid churn).
    cr = _cr("cp", phase="Pending")  # has status.phase=Pending, no host
    k = FakeK8s([], [cr])
    reconcile_once(k, cap=1)
    assert k.patches == [], "an already-materialized Pending must not be re-patched"


def test_notify_revive_returns_immediately_even_if_the_http_hangs():
    # REGRESSION (found live on odin): notify_revive did a SYNCHRONOUS HTTP POST; a stale,
    # unroutable hostIP hung the connect well past the timeout, wedging the whole reconcile
    # pass so NO conversation got assigned. The real ControllerK8s.notify_revive must be
    # FIRE-AND-FORGET — return promptly regardless of the HTTP outcome. We point it at an
    # unroutable IP (TEST-NET-1, guaranteed to black-hole) and assert it returns fast.
    import time
    from conversation_controller.k8s import ControllerK8s

    k = ControllerK8s(namespace="x")
    t = time.time()
    k.notify_revive("192.0.2.1", "c1", 1)  # 192.0.2.0/24 = RFC5737 TEST-NET-1, unroutable
    elapsed = time.time() - t
    assert elapsed < 1.0, f"notify_revive blocked {elapsed:.1f}s (must be fire-and-forget)"


def test_assign_patches_host_ip_and_pushes_revive():
    # The loop records the owner pod's IP (routing address) and pushes a revive to it.
    k = FakeK8s([Pod("a", True, ip="10.42.0.7")], [_cr("c1")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostIP"] == "10.42.0.7"
    # revive-push to the new host: (host_ip, conv_name, generation)
    assert k.revives == [("10.42.0.7", "c1", 1)]


def test_no_revive_push_when_pod_has_no_ip_yet():
    # A just-scheduled pod (no IP) is assigned but NOT pushed — the next tick re-pushes.
    k = FakeK8s([Pod("a", True, ip=None)], [_cr("c1")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostPod"] == "a"
    assert k.revives == []


def test_assigned_to_ready_host_is_noop():
    k = FakeK8s([Pod("a", True)], [_cr("c1", host="a", phase="Assigned", gen=1)])
    reconcile_once(k, cap=10)
    assert k.patches == []  # nothing patched


def test_host_gone_triggers_reassign_with_gen_bump():
    # c1 was on "a"; now only "b" exists -> reassign to b, gen 1 -> 2.
    k = FakeK8s([Pod("b", True)], [_cr("c1", host="a", phase="Assigned", gen=1)])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostPod"] == "b"
    assert k.status("c1")["generation"] == 2


def test_suspended_conversation_is_detached_end_to_end():
    # The live bug end-to-end: a conversation phase=Suspended still carries a stale hostPod
    # (suspend() wrote phase, not host). reconcile_once must RELEASE the host (Detach) — never
    # reassign it — so it stops counting as demand + isn't shown on a dead pod. Phase stays
    # Suspended (the host owns that transition). BOTH placement fields are released: hostPod
    # (fencing identity) AND hostIP (routing address) — else the router keeps dialing the IP.
    k = FakeK8s([Pod("a", True)], [_cr("c1", host="a", phase="Suspended", gen=1, host_ip="10.1.4.35")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostPod"] is None
    assert k.status("c1")["hostIP"] is None  # stale routing IP cleared, not left on a dead pod
    assert k.status("c1").get("phase") == "Suspended"  # untouched — only placement released


def test_suspended_stale_hostip_without_hostpod_is_repaired():
    # THE stale-hostIP bug (docs/scooter-bug-stale-hostip-routes-to-dead-pod.md): after a
    # rollout the CR is {Suspended, hostPod: null, hostIP: <dead pod>}. reconcile_once must
    # REPAIR it — clear the stale hostIP — so the router falls back to a live pod instead of
    # dialing the dead address forever. (Before the fix this was a NoOp: hostPod was already
    # null so nothing was patched, and hostIP lingered.)
    k = FakeK8s([Pod("a", True)], [_cr("c1", phase="Suspended", gen=2, host_ip="10.1.4.35")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostIP"] is None
    assert k.status("c1")["hostPod"] is None
    assert k.status("c1").get("phase") == "Suspended"


def test_suspended_conversation_already_hostless_is_noop():
    # Steady state {Suspended, hostPod: null, hostIP: null} → no patch (no churn every tick).
    cr = _cr("c1", phase="Suspended")  # no host, no ip
    k = FakeK8s([Pod("a", True)], [cr])
    reconcile_once(k, cap=10)
    assert k.patches == []


def test_two_pending_convs_balance_across_two_pods():
    k = FakeK8s([Pod("a", True), Pod("b", True)], [_cr("c1"), _cr("c2")])
    reconcile_once(k, cap=10)
    hosts = {k.status("c1")["hostPod"], k.status("c2")["hostPod"]}
    assert hosts == {"a", "b"}  # spread, not both on the same pod


def test_respects_cap_leaves_pending():
    # one pod, cap 1, and it already hosts c1 -> c2 stays Pending (no host).
    k = FakeK8s([Pod("a", True)], [_cr("c1", host="a", phase="Assigned", gen=1), _cr("c2")])
    reconcile_once(k, cap=1)
    assert "hostPod" not in k.status("c2") or k.status("c2").get("hostPod") is None
    assert k.status("c2")["phase"] == "Pending"


def test_no_ready_pods_leaves_all_pending():
    k = FakeK8s([Pod("a", False)], [_cr("c1")])
    reconcile_once(k, cap=10)
    assert k.status("c1").get("hostPod") is None


def test_subagent_colocates_with_parent_in_one_pass():
    # Parent p1 unassigned + child pointing at it, both pending, two pods available. The
    # parent is assigned first; the child follows onto the SAME pod in the same pass —
    # even though cap=1 and the parent already fills it (co-location bypasses cap).
    k = FakeK8s([Pod("a", True), Pod("b", True)], [_cr("p1"), _cr("kid", parent="p1")])
    reconcile_once(k, cap=1)
    assert k.status("kid")["hostPod"] == k.status("p1")["hostPod"]


def test_subagent_stays_pending_until_parent_ready():
    # Parent lives on a NotReady pod → the child can't co-locate yet.
    k = FakeK8s([Pod("a", False)], [_cr("p1", host="a", phase="Assigned", gen=1), _cr("kid", parent="p1")])
    reconcile_once(k, cap=10)
    assert k.status("kid").get("hostPod") is None
    assert k.status("kid")["phase"] == "Pending"


# --- the agent-host autoscaler loop ----------------------------------------

class _Cfg:
    """Minimal config for autoscale_once (only the fields it reads)."""
    def __init__(self, pod_cap=1, min_replicas=2, max_replicas=10, cooldown=300.0):
        self.pod_cap = pod_cap
        self.min_replicas = min_replicas
        self.max_replicas = max_replicas
        self.scale_down_cooldown_seconds = cooldown


def _cr_a(name, parent=None):
    # A minimal assigned conversation CR (host set so it counts as demand regardless).
    return _cr(name, host="a", phase="Assigned", gen=1, parent=parent)


def test_autoscale_scales_up_immediately():
    # 4 top-level conversations @ cap 1, currently 2 replicas -> scale to 4 at once.
    convs = [_cr_a(f"c{i}") for i in range(4)]
    k = FakeK8s([Pod("a", True), Pod("b", True)], convs, replicas=2)
    st = AutoscaleState()
    m = autoscale_once(k, _Cfg(pod_cap=1, max_replicas=10), st, now=1000.0)
    assert k.scale_calls == [4]
    assert m["demand"] == 4 and m["target"] == 4


def test_autoscale_subagents_do_not_count():
    # A subagent (parentId set) co-locates on the parent's pod -> not independent demand.
    convs = [_cr_a("p1"), _cr_a("kid", parent="p1")]
    k = FakeK8s([Pod("a", True)], convs, replicas=2)
    m = autoscale_once(k, _Cfg(pod_cap=1), AutoscaleState(), now=1.0)
    assert m["demand"] == 1  # only the top-level p1


def test_autoscale_scale_down_waits_for_cooldown():
    # Demand dropped (0 top-level) -> target = min (2), but current is 5. First tick is within
    # cooldown of the initial last_scale_down=0? No — now is large, so first down happens; then
    # a second down within cooldown is HELD.
    k = FakeK8s([Pod("a", True)], [], replicas=5)
    st = AutoscaleState()
    # First down at t=1000: allowed (1000 - 0 >= 300).
    autoscale_once(k, _Cfg(pod_cap=1, cooldown=300.0), st, now=1000.0)
    assert k.scale_calls == [2]
    # Bump replicas back up (simulate churn) and try to scale down again 100s later -> HELD.
    k._replicas = 4
    autoscale_once(k, _Cfg(pod_cap=1, cooldown=300.0), st, now=1100.0)
    assert k.scale_calls == [2]  # no new down within cooldown


def test_autoscale_noop_when_target_equals_current():
    convs = [_cr_a("c1"), _cr_a("c2")]
    k = FakeK8s([Pod("a", True), Pod("b", True)], convs, replicas=2)
    autoscale_once(k, _Cfg(pod_cap=1), AutoscaleState(), now=1.0)
    assert k.scale_calls == []  # 2 demand @ cap 1 = 2 = current, no change


def test_autoscale_per_pod_metric():
    convs = [_cr_a(f"c{i}") for i in range(6)]
    k = FakeK8s([Pod("a", True), Pod("b", True)], convs, replicas=2)
    m = autoscale_once(k, _Cfg(pod_cap=5), AutoscaleState(), now=1.0)
    assert m["per_pod"] == 3.0  # 6 conversations / 2 ready pods


# --- phase-drift repair through the shell (MarkSuspended end-to-end) --------

def test_drifted_conversation_is_repaired_and_leaves_demand():
    # THE 2026-08-22 INCIDENT IN MINIATURE: 14 CRs sat Assigned-on-a-ready-pod while their
    # sandboxes were Suspended (the suspending pod wasn't the owner, so the fenced setPhase
    # never published; the controller then assigned right over the suspended reality). The
    # "host still ready" NoOp kept them Assigned forever, and demand_of() counted every one —
    # the fleet could never scale down.
    from conversation_controller.reconcile import SandboxRef

    k8s = FakeK8s(
        pods=[Pod("a", True, ip="10.0.0.1")],
        convs=[_cr("drifted", host="a", phase="Assigned", gen=3, sandbox_ref="conv-x")],
        sandboxes=[SandboxRef(name="conv-x", age_seconds=1000.0, operating_mode="Suspended")],
    )
    results = reconcile_once(k8s, cap=10)

    assert ("drifted", "mark-suspended") in results
    # ONE patch: phase to the sandbox truth + placement released (router must stop routing
    # to a pod that no longer hosts it; demand must stop counting it).
    assert ("drifted", {"phase": "Suspended", "hostPod": None, "hostIP": None}) in k8s.patches
    st = k8s._convs["drifted"]["status"]
    assert st["phase"] == "Suspended"
    assert st["hostPod"] is None


def test_running_sandbox_is_not_repaired():
    from conversation_controller.reconcile import SandboxRef

    k8s = FakeK8s(
        pods=[Pod("a", True, ip="10.0.0.1")],
        convs=[_cr("live", host="a", phase="Assigned", gen=1, sandbox_ref="conv-y")],
        sandboxes=[SandboxRef(name="conv-y", age_seconds=1000.0, operating_mode="Running")],
    )
    results = reconcile_once(k8s, cap=10)
    assert ("live", "noop") in results
    assert not any(p[1].get("phase") == "Suspended" for p in k8s.patches)


def test_sandbox_list_failure_must_not_abort_assignment():
    # THE k3d SMOKE REGRESSION: the fake-sandbox stack has no Sandbox CRD, so
    # list_sandboxes() throws — and an unguarded call at the top of reconcile_once killed
    # every tick before ANY assignment (all three smoke tests timed out on waitFor
    # hostPod/hostIP). Same design rule the reaper already documents: sandbox listing is
    # AUXILIARY (it powers the drift repair); assignment must proceed without it. No
    # sandbox info = no evidence = no drift repairs this tick, and that is all.
    class ExplodingSandboxes(FakeK8s):
        def list_sandboxes(self):
            raise RuntimeError("the server could not find the requested resource (CRD absent)")

    k8s = ExplodingSandboxes(
        pods=[Pod("a", True, ip="10.0.0.1")],
        convs=[_cr("newborn")],  # unassigned — needs the controller
    )
    results = reconcile_once(k8s, cap=10)
    assert ("newborn", "assign") in results  # assignment still happened
    assert not any(kind == "mark-suspended" for _, kind in results)


# --- scale-down victim steering (pod-deletion-cost) ---------------------------
#
# Observed in e2e-full CI (run 33015148191): conversation 82d29b1f assigned to a pod
# at 21:32:57, autoscale down 5->2 at 21:33:07 killed that pod, the run died with it,
# and the browser showed "Working…" forever. The Deployment picks scale-down victims
# blindly unless pods carry controller.kubernetes.io/pod-deletion-cost.


def _conv(name, host, phase="Assigned", parent=None):
    return {
        "metadata": {"name": name},
        "spec": ({"parentId": parent} if parent else {}),
        "status": {"phase": phase, "hostPod": host, "generation": 1},
    }


def test_hosting_pods_get_their_conversation_count_as_deletion_cost():  # @proves
    pods = [Pod("a", True, "10.0.0.1"), Pod("b", True, "10.0.0.2")]
    k8s = FakeK8s(pods, [_conv("c1", "a"), _conv("c2", "a"), _conv("c3", "b")])
    autoscale_once(k8s, _Cfg(), AutoscaleState(), now=0.0)
    assert ("a", 2) in k8s.cost_calls
    assert ("b", 1) in k8s.cost_calls


def test_empty_pods_cost_zero_and_unchanged_costs_are_not_repatched():  # @proves
    # Pod "a" already carries the right cost (1) -> no patch; "b" is empty -> cost 0.
    pods = [Pod("a", True, "10.0.0.1", deletion_cost=1), Pod("b", True, "10.0.0.2")]
    k8s = FakeK8s(pods, [_conv("c1", "a")])
    autoscale_once(k8s, _Cfg(), AutoscaleState(), now=0.0)
    assert ("a", 1) not in k8s.cost_calls, "unchanged cost must not be re-patched"
    assert ("b", 0) in k8s.cost_calls


def test_suspended_and_subagent_conversations_do_not_count():  # @proves
    pods = [Pod("a", True, "10.0.0.1")]
    k8s = FakeK8s(pods, [
        _conv("c1", "a", phase="Suspended"),
        _conv("c2", "a", parent="c-parent"),
        _conv("c3", "a"),
    ])
    autoscale_once(k8s, _Cfg(), AutoscaleState(), now=0.0)
    assert ("a", 1) in k8s.cost_calls


def test_terminating_pods_are_not_assignment_targets():  # @proves
    # A scale-down victim stays Ready through its grace period; assigning to it just
    # schedules another mid-run reassignment (CI: assigned 23:40:26 -> reassigned
    # 23:40:34, the same conversation). Only the live pod may receive work.
    pods = [Pod("dying", True, "10.0.0.1", terminating=True), Pod("alive", True, "10.0.0.2")]
    k8s = FakeK8s(pods, [_conv("c1", None, phase="Pending")])
    reconcile_once(k8s, cap=10)
    assigned = [st for name, st in k8s.patches if name == "c1"]
    assert assigned, "the conversation must be assigned"
    assert all(st.get("hostPod") != "dying" for st in assigned), "never to a terminating pod"


# --- zombie sandbox: backoff + terminal resolution (no infinite re-suspend) ------------
#
# A zombie is phase=Suspended + placement released + Sandbox still RUNNING (reconcile returns
# SuspendSandbox). The bug: with no backoff and no terminal path, a suspend that never takes —
# exactly why a sandbox is a zombie (an upstream resume race keeps reviving the pod) — was
# re-detected and re-suspended every tick (every ~5s) forever. The fix keeps the two-tick
# false-positive confirmation but adds backoff between suspends and, after N bounded attempts,
# a terminal escalation (force-delete the Sandbox + mark the conversation Failed), logged once.


def _zombie():
    """A conversation the reconcile core flags as a zombie every tick: phase=Suspended,
    unhosted, backing Sandbox operatingMode=Running."""
    convs = [_cr("z1", phase="Suspended", gen=2, sandbox_ref="conv-z1")]
    sbs = [SandboxRef("conv-z1", age_seconds=1000, operating_mode="Running")]
    return FakeK8s([Pod("a", True)], convs, sandboxes=sbs)


def test_zombie_two_tick_confirmation_no_suspend_on_single_sighting():
    # The false-positive guard is preserved: a SINGLE sighting only marks a suspect — a real
    # revive patches the Sandbox Running before writing phase=Assigned, so one sighting can be
    # a revive mid-flight and must not be suspended.
    k = _zombie()
    res = dict(reconcile_once(k, cap=10))
    assert res["z1"] == "suspend-sandbox-suspect"
    assert k.suspends == []


def test_zombie_suspect_resets_when_conversation_revives():
    # A suspect that turns out to be a mid-flight revive (Running sandbox, now Assigned+hosted)
    # must be dropped — never suspended, and its confirmation state reset.
    k = _zombie()
    reconcile_once(k, cap=10)  # t1: suspect
    assert k.suspends == []
    k._convs["z1"]["status"].update({"phase": "Assigned", "hostPod": "a"})
    reconcile_once(k, cap=10)  # t2: NoOp — not a zombie
    assert k.suspends == []
    assert "z1" not in loop_mod._zombie_progress  # confirmation reset


def test_confirmed_zombie_is_not_resuspended_every_tick():
    # (a) After confirmation the first suspend fires, but the loop then BACKS OFF — it does not
    # re-issue the same suspend on every subsequent tick.
    k = _zombie()
    reconcile_once(k, cap=10)  # t1: suspect
    reconcile_once(k, cap=10)  # t2: first suspend
    assert k.suspends == ["conv-z1"]
    reconcile_once(k, cap=10)  # t3: backoff hold
    reconcile_once(k, cap=10)  # t4: backoff hold
    assert k.suspends == ["conv-z1"], "confirmed zombie must back off, not re-suspend every tick"


def test_persistent_zombie_is_acted_on_a_bounded_number_of_times_then_terminal():
    # (a)+(b): a sandbox whose suspend never takes is suspended only a small BOUNDED number of
    # times — not indefinitely — and then escalates to a TERMINAL resolution.
    k = _zombie()
    for _ in range(50):
        reconcile_once(k, cap=10)
    assert 1 <= len(k.suspends) <= 5, f"expected a small bounded number of suspends, got {len(k.suspends)}"
    # Terminal: force-delete the running Sandbox (reclaims the leaked pod) + mark conversation Failed.
    assert k.force_deleted == ["conv-z1"]
    assert k.status("z1")["phase"] == "Failed"
    # Idempotent terminal — never suspended again once resolved.
    at_terminal = len(k.suspends)
    for _ in range(10):
        reconcile_once(k, cap=10)
    assert len(k.suspends) == at_terminal
    assert k.force_deleted == ["conv-z1"]  # not force-deleted again either


def test_failed_conversation_is_never_reassigned():
    # The terminal Failed phase must be inert: an unhosted Failed conversation must NOT be
    # picked up and assigned to a pod by the reconcile core.
    k = FakeK8s([Pod("a", True)], [_cr("z1", phase="Failed", gen=9)])
    res = dict(reconcile_once(k, cap=10))
    assert res["z1"] == "noop"
    assert k.status("z1").get("hostPod") is None
    assert k.status("z1")["phase"] == "Failed"


def test_zombie_resolution_is_logged_once(caplog):
    # (c) The terminal resolution is logged ONCE, not once per tick.
    import logging
    k = _zombie()
    with caplog.at_level(logging.WARNING, logger="conversation_controller.loop"):
        for _ in range(50):
            reconcile_once(k, cap=10)
    escalations = [r for r in caplog.records if "escalat" in r.getMessage().lower()]
    assert len(escalations) == 1, f"escalation must be logged once, saw {len(escalations)}"
