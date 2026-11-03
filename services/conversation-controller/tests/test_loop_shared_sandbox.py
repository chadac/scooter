"""Zombie repair on a Sandbox shared by a parent and its subagents (issue #1094).

A subagent row carries its parent's sandbox_ref, but the agent-host never suspends that Sandbox for
a subagent, so a Suspended subagent next to a Running Sandbox is normal, not a zombie.
"""

from conversation_controller.loop import reconcile_once
from conversation_controller.reconcile import Pod, SandboxRef
from tests.test_loop import FakeK8s, FakeRows, _cr, _reset_zombie_state  # noqa: F401


def _run(convs, mode="Running", ticks=20):
    k = FakeK8s([Pod("a", True)], convs,
                sandboxes=[SandboxRef("conv-parent", age_seconds=1000, operating_mode=mode)])
    for _ in range(ticks):
        reconcile_once(k, cap=10, rows=FakeRows(k))
    return k


def test_an_idle_subagent_does_not_touch_its_parents_sandbox():
    k = _run([
        _cr("parent", host="a", phase="Assigned", gen=1, sandbox_ref="conv-parent"),
        _cr("child", phase="Suspended", gen=1, parent="parent", sandbox_ref="conv-parent"),
    ])
    assert k.suspends == []
    assert k.reclaimed == []
    assert k.status("child")["phase"] == "Suspended"


def test_a_real_zombie_is_still_repaired_through_the_parent_row():
    k = _run([
        _cr("parent", phase="Suspended", gen=1, sandbox_ref="conv-parent"),
        _cr("child", phase="Suspended", gen=1, parent="parent", sandbox_ref="conv-parent"),
    ])
    assert k.suspends
    assert k.status("child")["phase"] == "Suspended"
