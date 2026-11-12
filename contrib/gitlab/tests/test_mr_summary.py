"""gitlab_mr_summary: target resolution, the degraded secondary reads, and the rendered summary."""

from __future__ import annotations

import copy

import httpx

from scooter_broker_lib.mcp import gate_for

from scooter_contrib_gitlab import mcp_tools as tools
from test_mcp_tools import _ctx, _link

MR = {
    "title": "Add a thing",
    "web_url": "https://gitlab.com/g/p/-/merge_requests/3",
    "state": "opened",
    "draft": True,
    "detailed_merge_status": "draft_status",
    "has_conflicts": True,
    "author": {"username": "alice"},
    "source_branch": "feat/thing",
    "target_branch": "main",
    "sha": "abcdef1234567890",
    "changes_count": "3",
    "user_notes_count": 5,
    "labels": ["scooter"],
    "reviewers": [{"username": "dave"}],
    "head_pipeline": {"id": 99, "status": "failed", "web_url": "https://gitlab.com/p/99"},
}
APPROVALS = {"approved": False, "approvals_required": 2, "approvals_left": 1,
             "approved_by": [{"user": {"username": "bob"}}]}
DISCUSSIONS = [
    {"id": "d1", "notes": [{"body": "just a note", "resolvable": False, "author": {"username": "x"}}]},
    {"id": "d2", "notes": [{"body": "fine", "resolvable": True, "resolved": True, "author": {"username": "bob"}}]},
    {"id": "d3", "notes": [
        {"body": "please\nrename", "resolvable": True, "resolved": False, "author": {"username": "carol"},
         "position": {"new_path": "b.py", "new_line": 12}},
        {"body": "on it", "resolvable": True, "resolved": False, "author": {"username": "alice"}},
    ]},
]
JOBS = [
    {"name": "lint", "stage": "test", "status": "failed", "web_url": "https://gitlab.com/j/1"},
    {"name": "flaky", "stage": "test", "status": "failed", "allow_failure": True},
    {"name": "unit", "stage": "test", "status": "success"},
    {"name": "e2e", "stage": "test", "status": "running"},
]


PROJECT = {"only_allow_merge_if_all_discussions_are_resolved": True,
           "only_allow_merge_if_pipeline_succeeds": True}
ME = {"id": 7, "username": "scooter"}


def _responses(mr=MR, approvals=None, discussions=None, jobs=None, project=None, me=None):
    return [
        httpx.Response(200, json=mr),
        approvals or httpx.Response(200, json=APPROVALS),
        discussions or httpx.Response(200, json=DISCUSSIONS),
        *([jobs or httpx.Response(200, json=JOBS)] if mr.get("head_pipeline") else []),
        project or httpx.Response(200, json=PROJECT),
        me or httpx.Response(200, json=ME),
    ]


async def _summary(mr=MR, *, arg=None, **responses):
    ctx = _ctx(links=[_link(ref={"projectId": "g/p", "mrIid": "3"})], responses=_responses(mr, **responses))
    res = await tools.gitlab_mr_summary(mr=arg, ctx=ctx)
    return res, ctx


# --- targeting --------------------------------------------------------------------

async def test_the_tool_is_NOT_gated():
    assert gate_for("gitlab_mr_summary") is None


async def test_defaults_to_the_linked_mr_and_reads_everything():
    res, ctx = await _summary()
    assert res.is_error is False
    base = "api/v4/projects/g%2Fp/merge_requests/3"
    assert [c["path"] for c in ctx.upstream.calls] == [
        base, f"{base}/approvals", f"{base}/discussions", "api/v4/projects/g%2Fp/pipelines/99/jobs",
        "api/v4/projects/g%2Fp", "api/v4/user",
    ]


async def test_a_linked_ISSUE_is_skipped_for_a_later_mr():
    ctx = _ctx(links=[
        _link(ref={"projectId": "g/p", "iid": "1"}, rtype="issue"),
        _link(url="https://gitlab.com/g/p/-/merge_requests/2"),
    ], responses=_responses())
    await tools.gitlab_mr_summary(ctx=ctx)
    assert ctx.upstream.calls[0]["path"] == "api/v4/projects/g%2Fp/merge_requests/2"


async def test_an_explicit_mr_wins_in_either_form():
    for arg in ("https://gitlab.com/x/sub/y/-/merge_requests/9", "x/sub/y!9"):
        _, ctx = await _summary(arg=arg)
        assert ctx.upstream.calls[0]["path"] == "api/v4/projects/x%2Fsub%2Fy/merge_requests/9"


async def test_an_explicit_ISSUE_is_refused():
    res, ctx = await _summary(arg="g/p#3")
    assert res.is_error is True and ctx.upstream.calls == []


async def test_no_link_and_no_mr_is_an_error():
    res = await tools.gitlab_mr_summary(ctx=_ctx())
    assert res.is_error is True and "no linked GitLab MR" in res.text


# --- error paths ------------------------------------------------------------------

async def test_an_mr_read_failure_is_surfaced_verbatim():
    ctx = _ctx(responses=[httpx.Response(404, text="404 Not found")])
    res = await tools.gitlab_mr_summary(mr="g/p!3", ctx=ctx)
    assert res.is_error is True and "404 Not found" in res.text


async def test_a_failed_secondary_read_degrades_to_a_note():
    res, _ = await _summary(approvals=httpx.Response(403, text="forbidden"))
    assert res.is_error is False
    assert "Approvals: unavailable (HTTP 403: forbidden)" in res.text
    assert "Conversation:" in res.text


async def test_no_pipeline_skips_the_jobs_read():
    mr = copy.deepcopy(MR)
    mr["head_pipeline"] = None
    res, ctx = await _summary(mr)
    assert len(ctx.upstream.calls) == 5
    assert "CI (abcdef12): no pipeline" in res.text


# --- the rendered summary ---------------------------------------------------------

async def test_the_summary_covers_every_section():
    res, _ = await _summary()
    text = res.text
    assert 'g/p!3 "Add a thing" by @alice' in text
    assert "State: OPEN, DRAFT" in text
    assert "feat/thing -> main, head abcdef12" in text
    assert "Merge: draft_status, HAS CONFLICTS" in text
    assert "approved by @bob; 1 of 2 required approval(s) left; reviewers @dave" in text
    assert "pipeline failed https://gitlab.com/p/99. 4 jobs: 1 failed, 1 pending, 1 passed, 1 allowed to fail" in text
    assert "failed: lint [test] (failed) https://gitlab.com/j/1" in text
    assert "pending: e2e [test] (running)" in text
    assert "Conversation: 5 comment(s); 2 thread(s), 1 unresolved" in text
    assert 'b.py:12 @carol (discussion_id d3, 2 note(s)): "please rename"' in text
    assert "Labels: scooter" in text


async def test_blockers_name_everything_in_the_way():
    res, _ = await _summary()
    lines = res.text.splitlines()
    at = lines.index("Blockers (5 blocking merge):")
    assert lines[at + 1:] == [
        "  ✗ draft → mark it ready (remove the Draft: prefix) [you]",
        "  ✗ merge conflicts with `main` → rebase on `main` and push [you]",
        "  ✗ pipeline failed: lint → read the failing job's log, fix and push [you]",
        "  ✗ needs 1 more approval(s) → ask an eligible approver to approve [a reviewer]",
        "  ✗ 1 unresolved thread(s); the project REQUIRES all threads resolved"
        " → reply to each (and push any fix), then resolve it with gitlab_resolve_discussion [you]",
    ]


async def test_the_headline_case_an_approved_mr_held_only_by_required_thread_resolution():
    mr = copy.deepcopy(MR)
    mr.update(draft=False, has_conflicts=False, detailed_merge_status="discussions_not_resolved")
    mr["head_pipeline"]["status"] = "success"
    discussions = copy.deepcopy(DISCUSSIONS)
    discussions[2]["notes"][1]["author"]["id"] = ME["id"]
    res, _ = await _summary(
        mr,
        approvals=httpx.Response(200, json={**APPROVALS, "approved": True, "approvals_left": 0}),
        discussions=httpx.Response(200, json=discussions),
        jobs=httpx.Response(200, json=[JOBS[2]]),
    )
    assert res.text.splitlines()[-2:] == [
        "Blockers (1 blocking merge):",
        "  ✗ 1 unresolved thread(s); the project REQUIRES all threads resolved"
        " → you answered each last: resolve them with gitlab_resolve_discussion [you]",
    ]
    assert "2 note(s), you replied last)" in res.text


async def test_a_clean_mr_has_no_blockers():
    mr = copy.deepcopy(MR)
    mr.update(draft=False, has_conflicts=False, detailed_merge_status="mergeable")
    mr["head_pipeline"]["status"] = "success"
    res, _ = await _summary(
        mr,
        approvals=httpx.Response(200, json={**APPROVALS, "approved": True, "approvals_left": 0}),
        discussions=httpx.Response(200, json=DISCUSSIONS[:2]),
        jobs=httpx.Response(200, json=[JOBS[2]]),
    )
    assert "State: OPEN, ready for review" in res.text
    assert res.text.splitlines()[-1] == "Blockers: none"


async def test_a_merged_mr_has_no_blockers_line():
    mr = copy.deepcopy(MR)
    mr.update(state="merged", merged_at="2026-10-01T00:00:00Z")
    res, _ = await _summary(mr)
    assert "State: MERGED at 2026-10-01T00:00:00Z" in res.text
    assert "Blockers:" not in res.text
