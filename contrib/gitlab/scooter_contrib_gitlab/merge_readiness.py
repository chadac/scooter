"""What blocks a GitLab MR from merging, judged against its project's merge settings; no broker imports, since webhooks uses it too."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

AGENT, REVIEWER, ADMIN, WAIT = "you", "a reviewer", "an admin", "nobody (wait)"

PENDING_JOBS = {"created", "pending", "running", "waiting_for_resource", "preparing", "scheduled"}

# detailed_merge_status values that mean "nothing more to say".
_SETTLED = {"mergeable", "checking", "unchecked", "preparing", "approvals_syncing", "not_open"}

# Checks only detailed_merge_status reveals, one at a time.
_OTHER_CHECKS = {
    "requested_changes": ("a reviewer requested changes", "address them, push, then ask for a re-review", REVIEWER),
    "merge_request_blocked": ("blocked by a dependency MR that hasn't merged", "wait for it, or ask to drop it", WAIT),
    "blocked_status": ("blocked by a dependency MR that hasn't merged", "wait for it, or ask to drop it", WAIT),
    "external_status_checks": ("external status checks haven't passed", "check the MR's status checks", ADMIN),
    "jira_association_missing": (
        "the title or description must name a Jira issue", "add the issue key to the title or description", AGENT,
    ),
    "title_regex": ("the title doesn't match the project's required pattern", "edit the title to match", AGENT),
    "commits_status": ("a commit fails the project's commit rules", "check commit messages and signatures", AGENT),
    "security_policy_violations": ("a security policy blocks it", "ask a maintainer", ADMIN),
    "locked_paths": ("it changes a locked path", "ask whoever holds the lock", ADMIN),
    "locked_lfs_files": ("it changes a locked LFS file", "ask whoever holds the lock", ADMIN),
}


@dataclass(frozen=True)
class Blocker:
    """One thing between the MR and a merge."""

    detail: str
    fix: str
    # Who can clear it: AGENT, REVIEWER, ADMIN or WAIT.
    owner: str
    # False when no project setting enforces it.
    required: bool = True

    def line(self) -> str:
        mark = "✗" if self.required else "·"
        return f"  {mark} {self.detail} → {self.fix} [{self.owner}]"


def unresolved(discussions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The discussions with an unresolved resolvable note."""
    return [
        d for d in discussions
        if any(n.get("resolvable") and not n.get("resolved") for n in d.get("notes") or [])
    ]


def spoke_last(discussion: dict[str, Any], me: int | None) -> bool:
    """Whether user `me` wrote the discussion's last note."""
    notes = discussion.get("notes") or []
    return me is not None and bool(notes) and (notes[-1].get("author") or {}).get("id") == me


def blockers(
    mr: dict[str, Any],
    *,
    project: dict[str, Any] | None,
    approvals: dict[str, Any] | None,
    discussions: list[dict[str, Any]] | None,
    jobs: list[dict[str, Any]] | None = None,
    me: int | None = None,
) -> list[Blocker]:
    """Everything in the way of merging an open MR, required ones first.

    A None input was unreadable. `me` is the agent's user id; None skips telling
    the discussions it answered last from the rest, as for webhooks.
    """
    status = mr.get("detailed_merge_status") or ""
    target = mr.get("target_branch") or "the target branch"
    found: list[Blocker] = []
    if mr.get("draft") or mr.get("work_in_progress"):
        found.append(Blocker("draft", "mark it ready (remove the Draft: prefix)", AGENT))
    if mr.get("has_conflicts") or status == "conflict":
        found.append(Blocker(f"merge conflicts with `{target}`", f"rebase on `{target}` and push", AGENT))
    if status == "need_rebase":
        found.append(Blocker(
            f"behind `{target}` and the project merges fast-forward only", f"rebase on `{target}` and push", AGENT,
        ))
    pipeline = _pipeline_blocker(mr, project, jobs, status)
    if pipeline:
        found.append(pipeline)
    if (approvals or {}).get("approvals_left") or (approvals is None and status == "not_approved"):
        left = (approvals or {}).get("approvals_left")
        found.append(Blocker(
            f"needs {left} more approval(s)" if left else "not approved",
            "ask an eligible approver to approve", REVIEWER,
        ))
    threads = _thread_blocker(project, discussions, status, me)
    if threads:
        found.append(threads)
    if status in _OTHER_CHECKS:
        found.append(Blocker(*_OTHER_CHECKS[status]))
    elif status and status not in _SETTLED and not any(b.required for b in found):
        found.append(Blocker(
            f"GitLab reports `{status}`, which Scooter can't explain",
            "ask a maintainer what is blocking it; don't guess", ADMIN,
        ))
    return sorted(found, key=lambda b: not b.required)


def _pipeline_blocker(
    mr: dict[str, Any], project: dict[str, Any] | None, jobs: list[dict[str, Any]] | None, status: str,
) -> Blocker | None:
    pipeline = mr.get("head_pipeline") or {}
    state = pipeline.get("status")
    required = bool((project or {}).get("only_allow_merge_if_pipeline_succeeds")) or status in (
        "ci_must_pass", "ci_still_running",
    )
    if state in ("failed", "canceled"):
        failing = [
            j.get("name", "?") for j in jobs or []
            if j.get("status") == "failed" and not j.get("allow_failure")
        ]
        what = f"pipeline {state}" + (f": {', '.join(failing)}" if failing else "")
        return Blocker(what, "read the failing job's log, fix and push", AGENT, required)
    if state in PENDING_JOBS or status == "ci_still_running":
        return Blocker("pipeline still running", "wait for it", WAIT, required)
    if not state and required:
        return Blocker(
            "no pipeline on this head, and the project requires one to pass",
            "push to trigger one, or check the CI rules run for this branch", AGENT,
        )
    return None


def _thread_blocker(
    project: dict[str, Any] | None, discussions: list[dict[str, Any]] | None, status: str, me: int | None,
) -> Blocker | None:
    open_threads = unresolved(discussions or [])
    required = bool((project or {}).get("only_allow_merge_if_all_discussions_are_resolved")) or (
        status == "discussions_not_resolved"
    )
    if not open_threads:
        if discussions is None and status == "discussions_not_resolved":
            return Blocker("unresolved threads", "reply to each, then resolve it", AGENT)
        return None
    count = f"{len(open_threads)} unresolved thread(s)"
    if required:
        detail = f"{count}; the project REQUIRES all threads resolved"
    elif "only_allow_merge_if_all_discussions_are_resolved" in (project or {}):
        detail = f"{count}; not required by the project settings"
    else:
        detail = f"{count}; Scooter can't read whether the project requires resolving them"
    answered = [d for d in open_threads if spoke_last(d, me)]
    others = len(open_threads) - len(answered)
    if me is None:
        fix = "resolve the ones you've answered with gitlab_resolve_discussion; reply to the rest"
    elif answered and others:
        fix = (
            f"resolve the {len(answered)} you answered last with gitlab_resolve_discussion; "
            f"reply to the other {others} or ask the reviewer to resolve them"
        )
    elif answered:
        fix = "you answered each last: resolve them with gitlab_resolve_discussion"
    else:
        fix = "reply to each (and push any fix), then resolve it with gitlab_resolve_discussion"
    return Blocker(detail, fix, AGENT, required)


def render(found: list[Blocker]) -> list[str]:
    """The full blocker list, for gitlab_mr_summary."""
    if not found:
        return ["Blockers: none"]
    required = sum(1 for b in found if b.required)
    head = f"Blockers ({required} blocking merge):" if required else "Blockers: none blocking merge"
    return [head, *(b.line() for b in found)]


def note(found: list[Blocker]) -> str:
    """The short webhook tail: required blockers only."""
    required = [b for b in found if b.required]
    if not required:
        return "Merge: nothing blocks it."
    return "\n".join([
        "Still blocking merge:",
        *(b.line() for b in required),
        "gitlab_mr_summary has the details.",
    ])
