"""A GitHub PR's state, reviews, CI and conversation, fetched in one GraphQL query and rendered as text."""

from __future__ import annotations

from typing import Any

from scooter_broker_lib.mcp import ToolResult, UpstreamCaller
from scooter_broker_lib.refs import GithubTarget

from . import merge_readiness

# Unresolved threads listed by name; the rest are counted.
MAX_LISTED_THREADS = 20
MAX_LISTED_CHECKS = 15


async def fetch_pr_summary(upstream: UpstreamCaller, target: GithubTarget) -> ToolResult:
    """Fetch and render the PR, surfacing an upstream or GraphQL error verbatim."""
    response = await upstream.request(
        "POST",
        "graphql",
        json={
            "query": merge_readiness.QUERY,
            "variables": {"owner": target.owner, "repo": target.repo, "number": target.number},
        },
    )
    if not 200 <= response.status_code < 300:
        return ToolResult.from_upstream(response, success_text="")
    try:
        payload = response.json() or {}
    except ValueError:
        return ToolResult.error(f"GitHub returned a non-JSON response:\n{response.text}")
    pr = ((payload.get("data") or {}).get("repository") or {}).get("pullRequest")
    if not pr:
        messages = "; ".join(e.get("message", "") for e in payload.get("errors") or []) or "no data"
        return ToolResult.error(
            f"Could not read {_ref(target)} as a pull request (it may be an issue, or "
            f"not exist): {messages}"
        )
    return ToolResult.ok(render(target, pr))


def render(target: GithubTarget, pr: dict[str, Any]) -> str:
    """The summary text; `pr` is the GraphQL `pullRequest` object."""
    head = (pr.get("headRefOid") or "")[:7]
    lines = [
        f'{_ref(target)} "{pr.get("title", "")}" by @{_login(pr.get("author"))}',
        pr.get("url") or "",
        f"State: {_state(pr)}",
        f"Branch: {pr.get('headRefName')} -> {pr.get('baseRefName')}, head {head} "
        f"(+{pr.get('additions', 0)} -{pr.get('deletions', 0)}, {pr.get('changedFiles', 0)} files)",
    ]
    is_open = pr.get("state") == "OPEN"
    if is_open:
        merge = f"Merge: {pr.get('mergeable')} (merge state {pr.get('mergeStateStatus')})"
        queue = merge_readiness.queue_state(pr)
        lines.append(merge + (f"; {queue}" if queue else ""))

    lines.append(_reviews(pr))
    lines.extend(_check_lines(merge_readiness.Checks(pr), head))

    threads = _threads(pr)
    lines.extend(threads.lines(pr))

    labels = [n.get("name") for n in (pr.get("labels") or {}).get("nodes") or []]
    if labels:
        lines.append(f"Labels: {', '.join(labels)}")

    if is_open:
        lines.extend(merge_readiness.render(merge_readiness.blockers(pr)))
    return "\n".join(line for line in lines if line)


def _ref(target: GithubTarget) -> str:
    return f"{target.owner}/{target.repo}#{target.number}"


def _login(actor: dict[str, Any] | None) -> str:
    return (actor or {}).get("login") or "ghost"


def _state(pr: dict[str, Any]) -> str:
    if pr.get("merged"):
        return f"MERGED at {pr.get('mergedAt')}"
    if pr.get("state") == "CLOSED":
        return f"CLOSED (not merged) at {pr.get('closedAt')}"
    return "OPEN, DRAFT" if pr.get("isDraft") else "OPEN, ready for review"


def _reviews(pr: dict[str, Any]) -> str:
    by_state: dict[str, list[str]] = {}
    for review in (pr.get("latestOpinionatedReviews") or {}).get("nodes") or []:
        by_state.setdefault(review.get("state", ""), []).append("@" + _login(review.get("author")))
    awaiting = []
    for req in (pr.get("reviewRequests") or {}).get("nodes") or []:
        who = req.get("requestedReviewer") or {}
        awaiting.append(f"team {who['slug']}" if who.get("slug") else "@" + _login(who))
    parts = [f"Reviews: {pr.get('reviewDecision') or 'no decision reported'}"]
    for label, state in (("approved", "APPROVED"), ("changes requested", "CHANGES_REQUESTED")):
        if by_state.get(state):
            parts.append(f"{label} by {', '.join(by_state[state])}")
    if awaiting:
        parts.append(f"awaiting {', '.join(awaiting)}")
    elif not by_state:
        parts.append("no reviewers requested")
    return "; ".join(parts)


def _check_lines(checks: merge_readiness.Checks, head: str) -> list[str]:
    if not checks.rollup:
        return [f"CI ({head}): no checks reported"]
    counts = ", ".join(
        f"{len(group)} {label}"
        for label, group in (
            ("failed", checks.failed), ("pending", checks.pending),
            ("passed", checks.passed), ("skipped", checks.skipped),
        )
        if group
    )
    out = [f"CI ({head}): {checks.rollup.get('state')}. {checks.total} checks: {counts}"]
    seen = len(checks.passed) + len(checks.skipped) + len(checks.failed) + len(checks.pending)
    if checks.total > seen:
        out[0] += f" (first {seen} classified)"
    for label, group in (("failed", checks.failed), ("pending", checks.pending)):
        out.extend(f"  {label}: {item}" for item in group[:MAX_LISTED_CHECKS])
        if len(group) > MAX_LISTED_CHECKS:
            out.append(f"  ...and {len(group) - MAX_LISTED_CHECKS} more {label}")
    return out


class _Threads:
    def __init__(self, threads: dict[str, Any]):
        self.total = threads.get("totalCount") or 0
        self.nodes = threads.get("nodes") or []
        self.unresolved = [t for t in self.nodes if not t.get("isResolved")]
        self.review_comments = sum((t.get("comments") or {}).get("totalCount") or 0 for t in self.nodes)

    def lines(self, pr: dict[str, Any]) -> list[str]:
        comments = (pr.get("comments") or {}).get("totalCount") or 0
        outdated = sum(1 for t in self.unresolved if t.get("isOutdated"))
        head = (
            f"Conversation: {comments} comment(s); {self.review_comments} review comment(s) "
            f"in {self.total} thread(s), {len(self.unresolved)} unresolved"
        )
        if outdated:
            head += f" ({outdated} on outdated code)"
        if self.total > len(self.nodes):
            head += f" (first {len(self.nodes)} threads read)"
        out = [head]
        for thread in self.unresolved[:MAX_LISTED_THREADS]:
            out.append("  unresolved: " + _thread_line(thread))
        if len(self.unresolved) > MAX_LISTED_THREADS:
            out.append(f"  ...and {len(self.unresolved) - MAX_LISTED_THREADS} more unresolved")
        return out


def _threads(pr: dict[str, Any]) -> _Threads:
    return _Threads(pr.get("reviewThreads") or {})


def _thread_line(thread: dict[str, Any]) -> str:
    comments = thread.get("comments") or {}
    first = (comments.get("nodes") or [{}])[0]
    where = thread.get("path") or "?"
    if thread.get("line"):
        where += f":{thread['line']}"
    body = " ".join((first.get("body") or "").split())
    if len(body) > 100:
        body = body[:97] + "..."
    outdated = ", outdated" if thread.get("isOutdated") else ""
    answered = ", you replied last" if merge_readiness.viewer_spoke_last(thread) else ""
    return (
        f"{where} @{_login(first.get('author'))} (comment_id {first.get('databaseId')}, "
        f"{comments.get('totalCount', 0)} comment(s){outdated}{answered}): \"{body}\""
    )
