"""A GitLab MR's state, approvals, pipeline and discussions, fetched over REST and rendered as text."""

from __future__ import annotations

import asyncio
from typing import Any
from urllib.parse import quote

import httpx

from scooter_broker_lib.mcp import ToolResult, UpstreamCaller
from scooter_broker_lib.refs import GitlabTarget

from . import merge_readiness

MAX_LISTED_THREADS = 20
MAX_LISTED_JOBS = 15


async def fetch_mr_summary(upstream: UpstreamCaller, target: GitlabTarget) -> ToolResult:
    """Fetch and render the MR; only the MR read itself is fatal, the rest degrade to a note."""
    project = f"api/v4/projects/{quote(target.project_id, safe='')}"
    base = f"{project}/merge_requests/{target.iid}"
    mr_resp = await upstream.request("GET", base)
    if not 200 <= mr_resp.status_code < 300:
        return ToolResult.from_upstream(mr_resp, success_text="")
    mr = mr_resp.json() or {}
    pipeline = mr.get("head_pipeline") or {}

    async def jobs() -> httpx.Response | None:
        if not pipeline.get("id"):
            return None
        return await upstream.request(
            "GET", f"{project}/pipelines/{pipeline['id']}/jobs", params={"per_page": 100},
        )

    approvals, discussions, job_list, settings, me = await asyncio.gather(
        upstream.request("GET", f"{base}/approvals"),
        upstream.request("GET", f"{base}/discussions", params={"per_page": 100}),
        jobs(),
        upstream.request("GET", project),
        upstream.request("GET", "api/v4/user"),
    )
    return ToolResult.ok(render(target, mr, approvals, discussions, job_list, settings, me))


def render(
    target: GitlabTarget,
    mr: dict[str, Any],
    approvals: httpx.Response,
    discussions: httpx.Response,
    jobs: httpx.Response | None,
    project: httpx.Response,
    me: httpx.Response,
) -> str:
    sha = (mr.get("sha") or "")[:8]
    state = mr.get("state")
    is_open = state == "opened"
    my_id = (_json(me) or {}).get("id")
    lines = [
        f'{target.project_id}!{target.iid} "{mr.get("title", "")}" by @{_user(mr.get("author"))}',
        mr.get("web_url") or "",
        f"State: {_state(mr)}",
        f"Branch: {mr.get('source_branch')} -> {mr.get('target_branch')}, head {sha} "
        f"({mr.get('changes_count') or '?'} files changed)",
    ]
    if is_open:
        merge = f"Merge: {mr.get('detailed_merge_status') or mr.get('merge_status')}"
        if mr.get("has_conflicts"):
            merge += ", HAS CONFLICTS"
        if mr.get("merge_when_pipeline_succeeds"):
            merge += "; set to auto-merge when the pipeline succeeds"
        lines.append(merge)

    lines.append(_approvals(mr, approvals))
    lines.extend(_pipeline(mr.get("head_pipeline") or {}, sha, jobs))
    lines.extend(_discussions(mr, discussions, my_id))

    if mr.get("labels"):
        lines.append(f"Labels: {', '.join(mr['labels'])}")

    if is_open:
        found = merge_readiness.blockers(
            mr,
            project=_json(project),
            approvals=_json(approvals),
            discussions=_json(discussions),
            jobs=_json(jobs) if jobs is not None else None,
            me=my_id,
        )
        lines.extend(merge_readiness.render(found))
    return "\n".join(line for line in lines if line)


def _json(resp: httpx.Response | None) -> Any:
    """A successful response's body, else None."""
    if resp is None or not 200 <= resp.status_code < 300:
        return None
    try:
        return resp.json()
    except ValueError:
        return None


def _user(user: dict[str, Any] | None) -> str:
    return (user or {}).get("username") or "unknown"


def _state(mr: dict[str, Any]) -> str:
    state = mr.get("state")
    if state == "merged":
        return f"MERGED at {mr.get('merged_at')}"
    if state in ("closed", "locked"):
        return f"{state.upper()} (not merged) at {mr.get('closed_at')}"
    return "OPEN, DRAFT" if mr.get("draft") or mr.get("work_in_progress") else "OPEN, ready for review"


def _unavailable(what: str, resp: httpx.Response) -> str:
    return f"{what}: unavailable (HTTP {resp.status_code}: {resp.text[:200]})"


def _approvals(mr: dict[str, Any], resp: httpx.Response) -> str:
    reviewers = ", ".join("@" + _user(r) for r in mr.get("reviewers") or [])
    tail = f"; reviewers {reviewers}" if reviewers else "; no reviewers assigned"
    if not 200 <= resp.status_code < 300:
        return _unavailable("Approvals", resp) + tail
    data = resp.json() or {}
    approved_by = [_user(a.get("user")) for a in data.get("approved_by") or []]
    left = data.get("approvals_left") or 0
    parts = [f"Approvals: {'approved' if data.get('approved') else 'not approved'}"]
    if approved_by:
        parts.append("approved by " + ", ".join("@" + u for u in approved_by))
    if data.get("approvals_required"):
        parts.append(f"{left} of {data['approvals_required']} required approval(s) left")
    return "; ".join(parts) + tail


def _pipeline(pipeline: dict[str, Any], sha: str, resp: httpx.Response | None) -> list[str]:
    if not pipeline:
        return [f"CI ({sha}): no pipeline"]
    head = f"CI ({sha}): pipeline {pipeline.get('status')} {pipeline.get('web_url') or ''}".rstrip()
    if resp is None:
        return [head]
    if not 200 <= resp.status_code < 300:
        return [head, "  " + _unavailable("jobs", resp)]
    jobs = resp.json() or []
    failed = [j for j in jobs if j.get("status") == "failed" and not j.get("allow_failure")]
    allowed = [j for j in jobs if j.get("status") == "failed" and j.get("allow_failure")]
    pending = [j for j in jobs if j.get("status") in merge_readiness.PENDING_JOBS]
    manual = [j for j in jobs if j.get("status") == "manual"]
    passed = [j for j in jobs if j.get("status") == "success"]
    counts = ", ".join(
        f"{len(group)} {label}"
        for label, group in (
            ("failed", failed), ("pending", pending), ("passed", passed),
            ("allowed to fail", allowed), ("manual", manual),
        )
        if group
    )
    lines = [f"{head}. {len(jobs)} jobs: {counts}" if jobs else head]
    if resp.headers.get("x-next-page"):
        lines[0] += f" (first {len(jobs)} read)"
    for label, group in (("failed", failed), ("pending", pending)):
        for job in group[:MAX_LISTED_JOBS]:
            url = f" {job['web_url']}" if label == "failed" and job.get("web_url") else ""
            lines.append(f"  {label}: {job.get('name')} [{job.get('stage')}] ({job.get('status')}){url}")
        if len(group) > MAX_LISTED_JOBS:
            lines.append(f"  ...and {len(group) - MAX_LISTED_JOBS} more {label}")
    return lines


def _discussions(mr: dict[str, Any], resp: httpx.Response, me: int | None) -> list[str]:
    notes = mr.get("user_notes_count") or 0
    if not 200 <= resp.status_code < 300:
        return [f"Conversation: {notes} comment(s)", "  " + _unavailable("discussions", resp)]
    threads = [
        d for d in resp.json() or []
        if any(n.get("resolvable") for n in d.get("notes") or [])
    ]
    unresolved = merge_readiness.unresolved(threads)
    head = f"Conversation: {notes} comment(s); {len(threads)} thread(s), {len(unresolved)} unresolved"
    if resp.headers.get("x-next-page"):
        head += " (first page of discussions read)"
    lines = [head]
    for d in unresolved[:MAX_LISTED_THREADS]:
        lines.append("  unresolved: " + _thread_line(d, me))
    if len(unresolved) > MAX_LISTED_THREADS:
        lines.append(f"  ...and {len(unresolved) - MAX_LISTED_THREADS} more unresolved")
    return lines


def _thread_line(discussion: dict[str, Any], me: int | None) -> str:
    notes = discussion.get("notes") or []
    first = notes[0] if notes else {}
    position = first.get("position") or {}
    where = position.get("new_path") or position.get("old_path") or "MR"
    line = position.get("new_line") or position.get("old_line")
    if line:
        where += f":{line}"
    body = " ".join((first.get("body") or "").split())
    if len(body) > 100:
        body = body[:97] + "..."
    answered = ", you replied last" if merge_readiness.spoke_last(discussion, me) else ""
    return (
        f"{where} @{_user(first.get('author'))} (discussion_id {discussion.get('id')}, "
        f"{len(notes)} note(s){answered}): \"{body}\""
    )
