"""Merge blockers judged against the base branch's rules, from the GraphQL `pullRequest` shape."""

from __future__ import annotations

from scooter_contrib_github import merge_readiness as mr


def _pr(**kw):
    pr = {
        "state": "OPEN", "isDraft": False, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
        "reviewDecision": None, "baseRefName": "main", "headRefOid": "head",
        "latestOpinionatedReviews": {"nodes": []}, "reviewThreads": {"nodes": []},
        "baseRef": {"refUpdateRule": None, "rules": {"nodes": []}},
        "commits": {"nodes": [{"commit": {"statusCheckRollup": None}}]},
    }
    pr.update(kw)
    return pr


def _checks(*nodes):
    return {"nodes": [{"commit": {"statusCheckRollup": {
        "state": "FAILURE", "contexts": {"totalCount": len(nodes), "nodes": list(nodes)}}}}]}


def _run(name, conclusion, required):
    return {"__typename": "CheckRun", "name": name, "status": "COMPLETED", "conclusion": conclusion,
            "isRequired": required}


def _thread(viewer_last):
    return {"isResolved": False, "last": {"nodes": [{"viewerDidAuthor": viewer_last}]}}


def test_classic_protection_and_rulesets_combine():
    rule = mr.rules(_pr(baseRef={
        "refUpdateRule": {"requiresConversationResolution": False, "requiredApprovingReviewCount": 1,
                          "requiredStatusCheckContexts": ["build"]},
        "rules": {"nodes": [
            {"type": "PULL_REQUEST", "parameters": {
                "requiredReviewThreadResolution": True, "requiredApprovingReviewCount": 2,
                "requireLastPushApproval": True}},
            {"type": "REQUIRED_STATUS_CHECKS", "parameters": {"requiredStatusChecks": [{"context": "unit"}]}},
        ]},
    }))
    assert rule == mr.Rules(True, True, 2, False, True, frozenset({"build", "unit"}))


def test_unreadable_rules_are_marked_so():
    assert mr.rules(_pr(baseRef=None)).readable is False


def test_an_optional_failing_check_does_not_block_but_a_required_one_does():
    found = mr.blockers(_pr(commits=_checks(_run("lint", "FAILURE", False), _run("unit", "FAILURE", True))))
    assert [(b.detail, b.required) for b in found] == [
        ("failing check(s): unit", True),
        ("optional check(s) failing: lint", False),
    ]


def test_a_required_check_that_never_reported_is_named():
    pr = _pr(baseRef={"refUpdateRule": {"requiredStatusCheckContexts": ["build", "unit"]}, "rules": None},
             commits=_checks(_run("unit", "SUCCESS", True)))
    assert [b.detail for b in mr.blockers(pr)] == ["required check(s) never reported on this head: build"]


def test_an_approval_of_an_older_push_is_not_enough_when_the_rules_say_so():
    pr = _pr(
        baseRef={"refUpdateRule": None, "rules": {"nodes": [
            {"type": "PULL_REQUEST", "parameters": {"requireLastPushApproval": True}}]}},
        latestOpinionatedReviews={"nodes": [
            {"state": "APPROVED", "author": {"login": "bob"}, "commit": {"oid": "older"}}]},
    )
    [found] = mr.blockers(pr)
    assert "approval of the latest push" in found.detail and found.owner == mr.REVIEWER


def test_classic_protection_counts_approvals():
    pr = _pr(
        reviewDecision="REVIEW_REQUIRED",
        baseRef={"refUpdateRule": {"requiredApprovingReviewCount": 2}, "rules": None},
        latestOpinionatedReviews={"nodes": [{"state": "APPROVED", "author": {"login": "bob"}}]},
    )
    assert [b.detail for b in mr.blockers(pr)] == ["needs 2 approval(s), has 1"]


def test_threads_split_into_answered_and_not():
    pr = _pr(
        mergeStateStatus="BLOCKED",
        baseRef={"refUpdateRule": {"requiresConversationResolution": True}, "rules": None},
        reviewThreads={"nodes": [_thread(True), _thread(False), {"isResolved": True}]},
    )
    [found] = mr.blockers(pr)
    assert found.required and found.owner == mr.AGENT
    assert found.fix.startswith("resolve the 1 you answered last with github_resolve_thread; reply to the other 1")


def test_unrequired_threads_do_not_block():
    [found] = mr.blockers(_pr(reviewThreads={"nodes": [_thread(False)]}))
    assert not found.required and "not required by the branch rules" in found.detail
    assert mr.render([found])[0] == "Blockers: none blocking merge"


def test_the_webhook_note_lists_only_required_blockers():
    found = [mr.Blocker("a", "fix a", mr.AGENT), mr.Blocker("b", "fix b", mr.AGENT, required=False)]
    assert mr.note(found) == (
        "Still blocking merge:\n  ✗ a → fix a [you]\ngithub_pr_summary has the details."
    )
    assert mr.note(found[1:]) == "Merge: nothing blocks it."


def test_queue_state():
    assert mr.queue_state(_pr(isInMergeQueue=True, mergeQueueEntry={"position": 2, "state": "QUEUED"})) == (
        "in the merge queue at position 2 (queued)"
    )
    assert mr.queue_state(_pr(isMergeQueueEnabled=True)) == "not in the merge queue"
    assert mr.queue_state(_pr()) == ""


def test_a_missing_required_check_is_awaited_while_others_still_run():
    running = {"__typename": "CheckRun", "name": "e2e", "status": "IN_PROGRESS", "isRequired": False}
    pr = _pr(baseRef={"refUpdateRule": None, "rules": {"nodes": [
        {"type": "REQUIRED_STATUS_CHECKS", "parameters": {"requiredStatusChecks": [{"context": "gates"}]}}]}},
        commits=_checks(running))
    [found] = mr.blockers(pr)
    assert found.detail == "required check(s) not reported yet: gates" and found.owner == mr.WAIT
