"""Merge blockers judged against the project's merge settings, from the REST shapes."""

from __future__ import annotations

from scooter_contrib_gitlab import merge_readiness as mr

STRICT = {"only_allow_merge_if_all_discussions_are_resolved": True, "only_allow_merge_if_pipeline_succeeds": True}
LAX = {"only_allow_merge_if_all_discussions_are_resolved": False, "only_allow_merge_if_pipeline_succeeds": False}


def _mr(**kw):
    return {"state": "opened", "detailed_merge_status": "mergeable", "target_branch": "main", **kw}


def _thread(author_id, resolved=False):
    return {"id": "d", "notes": [
        {"resolvable": True, "resolved": resolved, "author": {"id": 1}},
        {"resolvable": True, "resolved": resolved, "author": {"id": author_id}},
    ]}


def _blockers(m=None, *, project=STRICT, approvals=None, discussions=None, jobs=None, me=None):
    return mr.blockers(m or _mr(), project=project, approvals=approvals or {}, discussions=discussions or [],
                       jobs=jobs, me=me)


def test_a_failed_pipeline_blocks_only_when_the_project_requires_success():
    failing = _mr(head_pipeline={"status": "failed"})
    jobs = [{"name": "lint", "status": "failed"}, {"name": "flaky", "status": "failed", "allow_failure": True}]
    [strict] = _blockers(failing, jobs=jobs)
    assert strict.required and strict.detail == "pipeline failed: lint"
    [lax] = _blockers(failing, project=LAX, jobs=jobs)
    assert not lax.required


def test_a_required_pipeline_that_never_ran_is_named():
    [found] = _blockers()
    assert found.detail.startswith("no pipeline on this head")


def test_threads_split_into_answered_and_not():
    [found] = _blockers(_mr(head_pipeline={"status": "success"}),
                        discussions=[_thread(7), _thread(1), _thread(1, resolved=True)], me=7)
    assert found.required
    assert found.fix.startswith("resolve the 1 you answered last with gitlab_resolve_discussion; reply to the other 1")


def test_unreadable_settings_fall_back_to_the_detailed_merge_status():
    m = _mr(detailed_merge_status="discussions_not_resolved", head_pipeline={"status": "success"})
    [found] = _blockers(m, project=None, discussions=[_thread(1)])
    assert found.required and "REQUIRES all threads resolved" in found.detail
    [found] = _blockers(_mr(head_pipeline={"status": "success"}), project={}, discussions=[_thread(1)])
    assert not found.required and "can't read" in found.detail


def test_a_check_the_reads_cant_see_is_named_from_the_detailed_status():
    [found] = _blockers(_mr(detailed_merge_status="requested_changes", head_pipeline={"status": "success"}))
    assert found.detail == "a reviewer requested changes" and found.owner == mr.REVIEWER


def test_an_unknown_status_says_so_instead_of_guessing():
    [found] = _blockers(_mr(detailed_merge_status="something_new", head_pipeline={"status": "success"}))
    assert "`something_new`" in found.detail and found.owner == mr.ADMIN


def test_approvals_left_block():
    [found] = _blockers(_mr(head_pipeline={"status": "success"}), approvals={"approvals_left": 2})
    assert found.detail == "needs 2 more approval(s)"


def test_the_webhook_note_lists_only_required_blockers():
    found = [mr.Blocker("a", "fix a", mr.AGENT), mr.Blocker("b", "fix b", mr.AGENT, required=False)]
    assert mr.note(found) == "Still blocking merge:\n  ✗ a → fix a [you]\ngitlab_mr_summary has the details."
    assert mr.note(found[1:]) == "Merge: nothing blocks it."
