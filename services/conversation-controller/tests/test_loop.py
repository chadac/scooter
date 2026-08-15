"""Tier 1 — the reconcile LOOP against a fake k8s (in-memory CRs + pods). No cluster."""

from conversation_controller.loop import reconcile_once, reap_orphans, autoscale_once, AutoscaleState
from conversation_controller.reconcile import Pod, SandboxRef


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


def _cr(name, host=None, phase="Pending", gen=0, parent=None, sandbox_ref=None):
    st = {"phase": phase, "generation": gen}
    if host is not None:
        st["hostPod"] = host
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


def test_phase_drift_corrects_stuck_assigned_to_suspended():
    # The live bug end-to-end: a conversation Assigned to a ready host, but its Sandbox is
    # actually Suspended (idle-suspended long ago; the setPhase(Suspended) 403'd). reconcile_once
    # must correct the CR phase → Suspended (self-heal), so the autoscaler stops counting it.
    k = FakeK8s(
        [Pod("a", True)],
        [_cr("c1", host="a", phase="Assigned", gen=1, sandbox_ref="conv-1")],
        sandboxes=[SandboxRef("conv-1", age_seconds=99999, operating_mode="Suspended")],
    )
    reconcile_once(k, cap=10)
    assert k.status("c1")["phase"] == "Suspended"
    assert k.status("c1")["hostPod"] is None  # dropped the host (no pod needed while suspended)


def test_phase_drift_leaves_assigned_when_sandbox_running():
    # A genuinely-active conversation (Sandbox Running) must stay Assigned — no false correction.
    k = FakeK8s(
        [Pod("a", True)],
        [_cr("c1", host="a", phase="Assigned", gen=1, sandbox_ref="conv-1")],
        sandboxes=[SandboxRef("conv-1", age_seconds=99999, operating_mode="Running")],
    )
    reconcile_once(k, cap=10)
    assert k.status("c1")["phase"] == "Assigned"
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
