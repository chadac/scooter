"""What blocks a GitHub PR from merging, judged against its base branch's rules; no broker imports, since webhooks uses it too."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

# Merge-relevant fields shared by github_pr_summary and the webhook notes.
QUERY = """query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      title url state isDraft merged mergedAt closedAt
      mergeable mergeStateStatus reviewDecision
      isMergeQueueEnabled isInMergeQueue mergeQueueEntry{state position}
      author{login}
      baseRefName headRefName headRefOid
      additions deletions changedFiles
      autoMergeRequest{mergeMethod}
      labels(first:20){nodes{name}}
      comments{totalCount}
      latestOpinionatedReviews(first:50){nodes{state author{login} commit{oid}}}
      reviewRequests(first:20){nodes{requestedReviewer{
        __typename
        ... on User{login} ... on Bot{login} ... on Mannequin{login} ... on Team{slug}
      }}}
      reviewThreads(first:100){
        totalCount
        nodes{
          isResolved isOutdated path line
          comments(first:1){totalCount nodes{databaseId body author{login}}}
          last: comments(last:1){nodes{viewerDidAuthor author{login}}}
        }
      }
      baseRef{
        refUpdateRule{
          requiresConversationResolution requiredApprovingReviewCount requiresCodeOwnerReviews
          requiredStatusCheckContexts
        }
        rules(first:50){nodes{type parameters{
          __typename
          ... on PullRequestParameters{
            requiredReviewThreadResolution requiredApprovingReviewCount
            requireCodeOwnerReview requireLastPushApproval
          }
          ... on RequiredStatusChecksParameters{requiredStatusChecks{context}}
        }}}
      }
      commits(last:1){nodes{commit{statusCheckRollup{
        state
        contexts(first:100){
          totalCount
          nodes{
            __typename
            ... on CheckRun{name status conclusion detailsUrl isRequired(pullRequestNumber:$number)}
            ... on StatusContext{context state targetUrl isRequired(pullRequestNumber:$number)}
          }
        }
      }}}}
    }
  }
}"""

_PASSED = {"SUCCESS"}
_SKIPPED = {"NEUTRAL", "SKIPPED"}

AGENT, REVIEWER, ADMIN, WAIT = "you", "a reviewer", "an admin", "nobody (wait)"


@dataclass(frozen=True)
class Blocker:
    """One thing between the PR and a merge."""

    detail: str
    fix: str
    # Who can clear it: AGENT, REVIEWER, ADMIN or WAIT.
    owner: str
    # False when no rule enforces it.
    required: bool = True

    def line(self) -> str:
        mark = "✗" if self.required else "·"
        return f"  {mark} {self.detail} → {self.fix} [{self.owner}]"


@dataclass(frozen=True)
class Rules:
    """The base branch's merge rules, merged from branch protection and rulesets."""

    readable: bool = False
    threads: bool = False
    approvals: int = 0
    code_owners: bool = False
    last_push_approval: bool = False
    checks: frozenset[str] = frozenset()


def rules(pr: dict[str, Any]) -> Rules:
    base = pr.get("baseRef") or {}
    protection = base.get("refUpdateRule") or {}
    ruleset = (base.get("rules") or {}).get("nodes") or []
    if not protection and base.get("rules") is None:
        return Rules()
    threads = bool(protection.get("requiresConversationResolution"))
    approvals = protection.get("requiredApprovingReviewCount") or 0
    code_owners = bool(protection.get("requiresCodeOwnerReviews"))
    last_push = False
    checks = set(protection.get("requiredStatusCheckContexts") or [])
    for rule in ruleset:
        params = rule.get("parameters") or {}
        if rule.get("type") == "PULL_REQUEST":
            threads |= bool(params.get("requiredReviewThreadResolution"))
            approvals = max(approvals, params.get("requiredApprovingReviewCount") or 0)
            code_owners |= bool(params.get("requireCodeOwnerReview"))
            last_push |= bool(params.get("requireLastPushApproval"))
        elif rule.get("type") == "REQUIRED_STATUS_CHECKS":
            checks |= {c.get("context") for c in params.get("requiredStatusChecks") or []}
    return Rules(True, threads, approvals, code_owners, last_push, frozenset(c for c in checks if c))


class Checks:
    """The head commit's checks, bucketed, with the required ones' problems kept apart."""

    def __init__(self, pr: dict[str, Any]):
        commits = (pr.get("commits") or {}).get("nodes") or []
        commit = (commits[0].get("commit") if commits else None) or {}
        self.rollup = commit.get("statusCheckRollup")
        self.passed: list[str] = []
        self.skipped: list[str] = []
        self.failed: list[str] = []
        self.pending: list[str] = []
        self.failed_required: list[str] = []
        self.pending_required: list[str] = []
        self.failed_optional: list[str] = []
        self.names: set[str] = set()
        self.total = 0
        if not self.rollup:
            return
        contexts = self.rollup.get("contexts") or {}
        self.total = contexts.get("totalCount") or 0
        for node in contexts.get("nodes") or []:
            if node.get("__typename") == "StatusContext":
                name, url, state = node.get("context"), node.get("targetUrl"), node.get("state")
                bucket = (
                    self.passed if state == "SUCCESS"
                    else self.pending if state in ("PENDING", "EXPECTED")
                    else self.failed
                )
            else:
                name, url = node.get("name"), node.get("detailsUrl")
                status, conclusion = node.get("status"), node.get("conclusion")
                state = conclusion if status == "COMPLETED" else status
                bucket = (
                    self.pending if status != "COMPLETED"
                    else self.passed if conclusion in _PASSED
                    else self.skipped if conclusion in _SKIPPED
                    else self.failed
                )
            bucket.append(f"{name} ({state})" + (f" {url}" if url and bucket is self.failed else ""))
            self.names.add(name)
            # Unknown counts as required, never waving a failure through.
            required = node.get("isRequired") is not False
            if bucket is self.failed:
                (self.failed_required if required else self.failed_optional).append(name)
            elif bucket is self.pending and required:
                self.pending_required.append(name)


def blockers(pr: dict[str, Any], *, split_threads: bool = True) -> list[Blocker]:
    """Everything in the way of merging an open PR, required ones first.

    `split_threads` tells threads the viewer answered last from the rest; off when the
    viewer is not the agent, as for webhooks.
    """
    rule = rules(pr)
    checks = Checks(pr)
    base = pr.get("baseRefName") or "base"
    found: list[Blocker] = []
    if pr.get("isDraft"):
        found.append(Blocker("draft", "mark it ready for review (gh pr ready)", AGENT))
    if pr.get("mergeable") == "CONFLICTING":
        found.append(Blocker(f"merge conflicts with `{base}`", f"rebase on `{base}` and push", AGENT))
    if pr.get("mergeStateStatus") == "BEHIND":
        found.append(Blocker(
            f"behind `{base}` and the rules require it up to date", f"rebase on `{base}` and push", AGENT,
        ))
    if checks.failed_required:
        found.append(Blocker(
            f"failing check(s): {', '.join(checks.failed_required)}",
            "read the failing log, fix and push", AGENT,
        ))
    # Skipped when a later page of checks went unread.
    missing = sorted(rule.checks - checks.names) if checks.total <= len(checks.names) else []
    if missing and checks.pending:
        # A summary check often reports only once the rest finish.
        found.append(Blocker(
            f"required check(s) not reported yet: {', '.join(missing)}", "wait for CI to finish", WAIT,
        ))
    elif missing:
        found.append(Blocker(
            f"required check(s) never reported on this head: {', '.join(missing)}",
            "check the workflow runs for this branch (path filters, forks); push to retrigger "
            "or ask a maintainer",
            AGENT,
        ))
    if checks.pending_required:
        found.append(Blocker(
            f"check(s) still running: {', '.join(checks.pending_required)}", "wait for them", WAIT,
        ))
    found.extend(_review_blockers(pr, rule))
    threads = _thread_blocker(pr, rule, split_threads)
    if threads:
        found.append(threads)

    required = [b for b in found if b.required]
    if pr.get("mergeStateStatus") == "BLOCKED" and not required:
        found.append(Blocker(
            "blocked by a rule Scooter can't read (an org ruleset, signed commits, or permissions)"
            if rule.readable else "blocked by branch rules Scooter can't read",
            "ask a maintainer what is blocking it; don't guess", ADMIN,
        ))
    if checks.failed_optional:
        found.append(Blocker(
            f"optional check(s) failing: {', '.join(checks.failed_optional)}",
            "fix if related; does not block merge", AGENT, required=False,
        ))
    return sorted(found, key=lambda b: not b.required)


def _review_blockers(pr: dict[str, Any], rule: Rules) -> list[Blocker]:
    reviews = (pr.get("latestOpinionatedReviews") or {}).get("nodes") or []
    approvers = [r for r in reviews if r.get("state") == "APPROVED"]
    requesting = ["@" + _login(r.get("author")) for r in reviews if r.get("state") == "CHANGES_REQUESTED"]
    found: list[Blocker] = []
    if requesting:
        found.append(Blocker(
            f"changes requested by {', '.join(requesting)}",
            "address the comments, push, then ask for a re-review", REVIEWER,
        ))
    head = pr.get("headRefOid")
    if rule.last_push_approval and approvers and all(
        (r.get("commit") or {}).get("oid") != head for r in approvers
    ):
        found.append(Blocker(
            "the rules require an approval of the latest push, and every approval is of an older commit",
            "ask a reviewer to approve the current head", REVIEWER,
        ))
    decision = pr.get("reviewDecision")
    if not requesting and decision == "REVIEW_REQUIRED":
        if rule.approvals and len(approvers) < rule.approvals:
            what = f"needs {rule.approvals} approval(s), has {len(approvers)}"
        elif rule.code_owners:
            what = "needs a code owner's approval"
        else:
            what = "review required"
        found.append(Blocker(what, "request a review from someone who can approve", REVIEWER))
    elif not requesting and decision is None and rule.approvals > len(approvers):
        found.append(Blocker(
            f"needs {rule.approvals} approval(s), has {len(approvers)}",
            "request a review from someone who can approve", REVIEWER,
        ))
    return found


def _thread_blocker(pr: dict[str, Any], rule: Rules, split: bool) -> Blocker | None:
    nodes = (pr.get("reviewThreads") or {}).get("nodes") or []
    unresolved = [t for t in nodes if not t.get("isResolved")]
    if not unresolved:
        return None
    count = f"{len(unresolved)} unresolved review thread(s)"
    if rule.threads:
        detail = f"{count}; the branch rules REQUIRE conversation resolution"
    elif rule.readable:
        detail = f"{count}; not required by the branch rules"
    else:
        detail = f"{count}; Scooter can't read whether the rules require resolving them"
    answered = [t for t in unresolved if viewer_spoke_last(t)] if split else []
    others = len(unresolved) - len(answered)
    if not split:
        fix = "resolve the ones you've answered with github_resolve_thread; reply to the rest"
    elif answered and others:
        fix = (
            f"resolve the {len(answered)} you answered last with github_resolve_thread; "
            f"reply to the other {others} or ask the reviewer to resolve them"
        )
    elif answered:
        fix = "you answered each last: resolve them with github_resolve_thread"
    else:
        fix = "reply to each (and push any fix), then resolve it with github_resolve_thread"
    return Blocker(detail, fix, AGENT, required=rule.threads)


def viewer_spoke_last(thread: dict[str, Any]) -> bool:
    last = ((thread.get("last") or {}).get("nodes") or [{}])[0]
    return last.get("viewerDidAuthor") is True


def _login(actor: dict[str, Any] | None) -> str:
    return (actor or {}).get("login") or "ghost"


def queue_state(pr: dict[str, Any]) -> str:
    """The merge-queue/auto-merge position, or "" when the repo has neither in play."""
    entry = pr.get("mergeQueueEntry")
    if pr.get("isInMergeQueue") and entry:
        return f"in the merge queue at position {entry.get('position')} ({str(entry.get('state')).lower()})"
    auto = pr.get("autoMergeRequest")
    if auto:
        return f"auto-merge on ({str(auto.get('mergeMethod') or '').lower()})"
    if pr.get("isMergeQueueEnabled"):
        return "not in the merge queue"
    return ""


def render(found: list[Blocker]) -> list[str]:
    """The full blocker list, for github_pr_summary."""
    required = sum(1 for b in found if b.required)
    if not found:
        return ["Blockers: none"]
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
        "github_pr_summary has the details.",
    ])
