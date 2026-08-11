"""Tier 1 — the reconcile LOOP against a fake k8s (in-memory CRs + pods). No cluster."""

from conversation_controller.loop import reconcile_once
from conversation_controller.reconcile import Pod


class FakeK8s:
    """In-memory Conversations + agent-host pods. patch_status merges into status."""

    def __init__(self, pods, convs):
        self._pods = pods                       # list[Pod]
        self._convs = {c["metadata"]["name"]: c for c in convs}
        self.patches = []                       # [(name, status)] for assertions
        self.revives = []                       # [(host_ip, conv_name, generation)] revive-pushes

    def list_host_pods(self):
        return list(self._pods)

    def list_conversations(self):
        return list(self._convs.values())

    def patch_status(self, name, status):
        self.patches.append((name, status))
        cur = self._convs[name].setdefault("status", {})
        cur.update({k: v for k, v in status.items()})

    def notify_revive(self, host_ip, conv_name, generation):
        self.revives.append((host_ip, conv_name, generation))

    # test helpers
    def status(self, name):
        return self._convs[name].get("status", {})


def _cr(name, host=None, phase="Pending", gen=0, parent=None):
    st = {"phase": phase, "generation": gen}
    if host is not None:
        st["hostPod"] = host
    spec = {}
    if parent is not None:
        spec["parentId"] = parent
    return {"metadata": {"name": name}, "spec": spec, "status": st}


def test_pending_conversation_gets_a_host():
    k = FakeK8s([Pod("a", True)], [_cr("c1")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostPod"] == "a"
    assert k.status("c1")["phase"] == "Assigned"
    assert k.status("c1")["generation"] == 1


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
