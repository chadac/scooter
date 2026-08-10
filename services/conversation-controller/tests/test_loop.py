"""Tier 1 — the reconcile LOOP against a fake k8s (in-memory CRs + pods). No cluster."""

from conversation_controller.loop import reconcile_once
from conversation_controller.reconcile import Pod


class FakeK8s:
    """In-memory Conversations + agent-host pods. patch_status merges into status."""

    def __init__(self, pods, convs):
        self._pods = pods                       # list[Pod]
        self._convs = {c["metadata"]["name"]: c for c in convs}
        self.patches = []                       # [(name, status)] for assertions

    def list_host_pods(self):
        return list(self._pods)

    def list_conversations(self):
        return list(self._convs.values())

    def patch_status(self, name, status):
        self.patches.append((name, status))
        cur = self._convs[name].setdefault("status", {})
        cur.update({k: v for k, v in status.items()})

    # test helpers
    def status(self, name):
        return self._convs[name].get("status", {})


def _cr(name, host=None, phase="Pending", gen=0):
    st = {"phase": phase, "generation": gen}
    if host is not None:
        st["hostPod"] = host
    return {"metadata": {"name": name}, "spec": {}, "status": st}


def test_pending_conversation_gets_a_host():
    k = FakeK8s([Pod("a", True)], [_cr("c1")])
    reconcile_once(k, cap=10)
    assert k.status("c1")["hostPod"] == "a"
    assert k.status("c1")["phase"] == "Assigned"
    assert k.status("c1")["generation"] == 1


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
