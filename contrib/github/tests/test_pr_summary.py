"""github_pr_summary: target resolution, the GraphQL error paths, and the rendered summary."""

from __future__ import annotations

import copy

import httpx

from scooter_broker_lib.mcp import gate_for

from scooter_contrib_github import mcp_tools as tools
from test_mcp_tools import _ctx, _link

PR = {
    "title": "Add a thing",
    "url": "https://github.com/o/r/pull/7",
    "state": "OPEN",
    "isDraft": True,
    "merged": False,
    "mergedAt": None,
    "closedAt": None,
    "mergeable": "CONFLICTING",
    "mergeStateStatus": "DIRTY",
    "reviewDecision": "CHANGES_REQUESTED",
    "author": {"login": "alice"},
    "baseRefName": "main",
    "headRefName": "feat/thing",
    "headRefOid": "abcdef1234567890",
    "additions": 10,
    "deletions": 2,
    "changedFiles": 3,
    "autoMergeRequest": None,
    "labels": {"nodes": [{"name": "scooter"}]},
    "comments": {"totalCount": 4},
    "latestOpinionatedReviews": {"nodes": [
        {"state": "APPROVED", "author": {"login": "bob"}},
        {"state": "CHANGES_REQUESTED", "author": {"login": "carol"}},
    ]},
    "reviewRequests": {"nodes": [
        {"requestedReviewer": {"__typename": "User", "login": "dave"}},
        {"requestedReviewer": {"__typename": "Team", "slug": "core"}},
    ]},
    "reviewThreads": {"totalCount": 2, "nodes": [
        {"isResolved": True, "isOutdated": False, "path": "a.py", "line": 1,
         "comments": {"totalCount": 2, "nodes": [{"databaseId": 1, "body": "ok", "author": {"login": "bob"}}]}},
        {"isResolved": False, "isOutdated": True, "path": "b.py", "line": 12,
         "comments": {"totalCount": 1, "nodes": [{"databaseId": 55, "body": "please\nrename", "author": {"login": "carol"}}]}},
    ]},
    "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "FAILURE", "contexts": {
        "totalCount": 4,
        "nodes": [
            {"__typename": "CheckRun", "name": "lint", "status": "COMPLETED", "conclusion": "FAILURE",
             "detailsUrl": "https://ci/lint"},
            {"__typename": "CheckRun", "name": "unit", "status": "COMPLETED", "conclusion": "SUCCESS"},
            {"__typename": "CheckRun", "name": "e2e", "status": "IN_PROGRESS", "conclusion": None},
            {"__typename": "StatusContext", "context": "deploy", "state": "SUCCESS", "targetUrl": None},
        ],
    }}}}]},
}


def _gql(pr=PR):
    return httpx.Response(200, json={"data": {"repository": {"pullRequest": pr}}})


async def _summary(data=PR, **kw):
    ctx = _ctx(links=[_link(ref={"owner": "o", "repo": "r", "number": 7})], responses=[_gql(data)])
    res = await tools.github_pr_summary(ctx=ctx, **kw)
    return res, ctx


# --- targeting --------------------------------------------------------------------

async def test_the_tool_is_NOT_gated_so_it_works_on_any_pr():
    assert gate_for("github_pr_summary") is None


async def test_defaults_to_the_linked_pr():
    res, ctx = await _summary()
    assert res.is_error is False
    call = ctx.upstream.calls[0]
    assert call["path"] == "graphql"
    assert call["json"]["variables"] == {"owner": "o", "repo": "r", "number": 7}


async def test_a_linked_ISSUE_is_skipped_for_a_later_pr():
    ctx = _ctx(links=[
        _link(ref={"owner": "o", "repo": "r", "number": 1}, rtype="issue"),
        _link(url="https://github.com/o/r/pull/2"),
    ], responses=[_gql()])
    await tools.github_pr_summary(ctx=ctx)
    assert ctx.upstream.calls[0]["json"]["variables"]["number"] == 2


async def test_an_explicit_pr_wins_in_either_form():
    for pr in ("https://github.com/x/y/pull/9", "x/y#9"):
        res, ctx = await _summary(pr=pr)
        assert ctx.upstream.calls[0]["json"]["variables"] == {"owner": "x", "repo": "y", "number": 9}


async def test_an_unparseable_pr_is_an_error():
    res, ctx = await _summary(pr="not a pr")
    assert res.is_error is True and "Could not parse" in res.text
    assert ctx.upstream.calls == []


async def test_no_link_and_no_pr_is_an_error():
    res = await tools.github_pr_summary(ctx=_ctx())
    assert res.is_error is True and "no linked GitHub PR" in res.text


# --- error paths ------------------------------------------------------------------

async def test_an_http_failure_is_surfaced_verbatim():
    ctx = _ctx(responses=[httpx.Response(401, text="Bad credentials")])
    res = await tools.github_pr_summary(pr="o/r#7", ctx=ctx)
    assert res.is_error is True and "401" in res.text and "Bad credentials" in res.text


async def test_a_graphql_error_names_the_cause():
    """An issue number comes back as a 200 with `errors` and a null pullRequest."""
    body = {"data": {"repository": {"pullRequest": None}},
            "errors": [{"message": "Could not resolve to a PullRequest with the number of 7."}]}
    ctx = _ctx(responses=[httpx.Response(200, json=body)])
    res = await tools.github_pr_summary(pr="o/r#7", ctx=ctx)
    assert res.is_error is True and "Could not resolve to a PullRequest" in res.text


# --- the rendered summary ---------------------------------------------------------

async def test_the_summary_covers_every_section():
    res, _ = await _summary()
    text = res.text
    assert 'o/r#7 "Add a thing" by @alice' in text
    assert "State: OPEN, DRAFT" in text
    assert "feat/thing -> main, head abcdef1" in text
    assert "Merge: CONFLICTING (merge state DIRTY)" in text
    assert "approved by @bob" in text
    assert "changes requested by @carol" in text
    assert "awaiting @dave, team core" in text
    assert "CI (abcdef1): FAILURE. 4 checks: 1 failed, 1 pending, 2 passed" in text
    assert "failed: lint (FAILURE) https://ci/lint" in text
    assert "pending: e2e (IN_PROGRESS)" in text
    assert "4 comment(s); 3 review comment(s) in 2 thread(s), 1 unresolved (1 on outdated code)" in text
    assert 'b.py:12 @carol (comment_id 55, 1 comment(s), outdated): "please rename"' in text
    assert "Labels: scooter" in text


async def test_blockers_name_everything_in_the_way():
    res, _ = await _summary()
    lines = res.text.splitlines()
    at = lines.index("Blockers (5 blocking merge):")
    assert lines[at + 1:] == [
        "  ✗ draft → mark it ready for review (gh pr ready) [you]",
        "  ✗ merge conflicts with `main` → rebase on `main` and push [you]",
        "  ✗ failing check(s): lint → read the failing log, fix and push [you]",
        "  ✗ check(s) still running: e2e → wait for them [nobody (wait)]",
        "  ✗ changes requested by @carol → address the comments, push, then ask for a re-review [a reviewer]",
        "  · 1 unresolved review thread(s); Scooter can't read whether the rules require resolving them"
        " → reply to each (and push any fix), then resolve it with github_resolve_thread [you]",
    ]


async def test_the_headline_case_an_approved_pr_held_only_by_required_thread_resolution():
    pr = copy.deepcopy(PR)
    pr.update(isDraft=False, mergeable="MERGEABLE", mergeStateStatus="BLOCKED", reviewDecision="APPROVED")
    pr["latestOpinionatedReviews"]["nodes"] = [{"state": "APPROVED", "author": {"login": "bob"}}]
    pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = None
    pr["reviewThreads"]["nodes"][1]["last"] = {"nodes": [{"viewerDidAuthor": True}]}
    pr["baseRef"] = {"refUpdateRule": None, "rules": {"nodes": [
        {"type": "PULL_REQUEST", "parameters": {"requiredReviewThreadResolution": True}}]}}
    res, _ = await _summary(pr)
    lines = res.text.splitlines()
    assert lines[-2:] == [
        "Blockers (1 blocking merge):",
        "  ✗ 1 unresolved review thread(s); the branch rules REQUIRE conversation resolution"
        " → you answered each last: resolve them with github_resolve_thread [you]",
    ]
    assert "outdated, you replied last)" in res.text


async def test_a_clean_pr_has_no_blockers():
    pr = copy.deepcopy(PR)
    pr.update(isDraft=False, mergeable="MERGEABLE", mergeStateStatus="CLEAN", reviewDecision="APPROVED")
    pr["latestOpinionatedReviews"]["nodes"] = [{"state": "APPROVED", "author": {"login": "bob"}}]
    pr["reviewThreads"]["nodes"][1]["isResolved"] = True
    pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = {
        "state": "SUCCESS",
        "contexts": {"totalCount": 1, "nodes": [
            {"__typename": "CheckRun", "name": "unit", "status": "COMPLETED", "conclusion": "SUCCESS"}]},
    }
    res, _ = await _summary(pr)
    assert "State: OPEN, ready for review" in res.text
    assert res.text.splitlines()[-1] == "Blockers: none"


async def test_a_merged_pr_reports_merged_and_no_blockers_line():
    pr = copy.deepcopy(PR)
    pr.update(state="MERGED", merged=True, mergedAt="2026-10-01T00:00:00Z")
    res, _ = await _summary(pr)
    assert "State: MERGED at 2026-10-01T00:00:00Z" in res.text
    assert "Blockers:" not in res.text and "Merge:" not in res.text


async def test_no_checks_is_said_plainly():
    pr = copy.deepcopy(PR)
    pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = None
    res, _ = await _summary(pr)
    assert "CI (abcdef1): no checks reported" in res.text


def _blocked_with_nothing_else(pr):
    pr.update(isDraft=False, mergeable="MERGEABLE", mergeStateStatus="BLOCKED", reviewDecision=None)
    pr["latestOpinionatedReviews"]["nodes"] = []
    pr["reviewThreads"]["nodes"][1]["isResolved"] = True
    pr["commits"]["nodes"][0]["commit"]["statusCheckRollup"] = None


async def test_a_ruleset_approval_shows_though_review_decision_is_null():
    # Shape seen live: ruleset needs an approval, reviewDecision stays null.
    pr = copy.deepcopy(PR)
    _blocked_with_nothing_else(pr)
    pr["baseRef"] = {"refUpdateRule": None, "rules": {"nodes": [
        {"type": "PULL_REQUEST", "parameters": {"requiredApprovingReviewCount": 1}}]}}
    res, _ = await _summary(pr)
    assert "Reviews: no decision reported" in res.text
    assert res.text.splitlines()[-1] == (
        "  ✗ needs 1 approval(s), has 0 → request a review from someone who can approve [a reviewer]"
    )


async def test_an_unexplained_block_says_so_instead_of_guessing():
    pr = copy.deepcopy(PR)
    _blocked_with_nothing_else(pr)
    res, _ = await _summary(pr)
    assert res.text.splitlines()[-1] == (
        "  ✗ blocked by branch rules Scooter can't read → ask a maintainer what is blocking it; "
        "don't guess [an admin]"
    )
