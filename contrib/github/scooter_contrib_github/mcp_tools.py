"""GitHub's agent tools: comment on the conversation's PR or issue, resolve its review threads, summarise a PR, and fetch an attachment."""

from __future__ import annotations

import logging

import httpx
from fastmcp import FastMCP

from scooter_broker_lib.attachments import attachment_tool
from scooter_broker_lib.links import first_target, links_for, ref_of, resource_type_is
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate
from scooter_broker_lib.refs import GithubTarget, parse_github_resource_id, parse_github_url

from scooter_lib.attachments import MAX_FILE_BYTES

from . import attachments
from .config import GitHubSettings
from .pr_summary import fetch_pr_summary

logger = logging.getLogger(__name__)

mcp = FastMCP(name="github")

SOURCE = "github"


def _target_from_link(link: dict) -> GithubTarget | None:
    """A link's target from its structured `ref`, else from its URL; the two are never mixed, since a link posted through the agent-host API carries only url+title."""
    ref = ref_of(link)
    owner, repo, number = ref.get("owner"), ref.get("repo"), ref.get("number")
    if owner and repo and number is not None:
        return GithubTarget(owner=owner, repo=repo, number=int(number))
    return parse_github_resource_id(link.get("url") or "")


async def github_targets(ctx: ToolContext) -> list[GithubTarget]:
    """Every distinct PR/issue this conversation is attached to, oldest first."""
    targets: list[GithubTarget] = []
    for link in links_for(await ctx.links.list(), SOURCE):
        target = _target_from_link(link)
        if target is not None and target not in targets:
            targets.append(target)
    return targets


def _name(target: GithubTarget) -> str:
    return f"{target.owner}/{target.repo}#{target.number}"


async def _review_comment_pr(
    ctx: ToolContext, targets: list[GithubTarget], comment_id: int
) -> GithubTarget | None:
    """The PR owning review comment `comment_id`, looked up in each linked repo."""
    for owner, repo in dict.fromkeys((t.owner, t.repo) for t in targets):
        response = await ctx.upstream.request(
            "GET", f"repos/{owner}/{repo}/pulls/comments/{comment_id}"
        )
        if not 200 <= response.status_code < 300:
            continue
        found = parse_github_url((response.json() or {}).get("html_url"))
        if found is not None:
            return found
    return None


async def _comment_target(
    ctx: ToolContext, target: str | None, in_reply_to: int | None
) -> GithubTarget | str:
    """The linked PR/issue to post on, or why none could be chosen."""
    linked = await github_targets(ctx)
    if not linked:
        return (
            "Could not determine the GitHub PR/issue for this conversation — it has no "
            "github link with owner/repo/number. Use the broker's /github proxy with an "
            "explicit owner/repo/number instead."
        )
    listing = ", ".join(_name(t) for t in linked)
    if target:
        chosen = parse_github_resource_id(target.strip())
        if chosen is None:
            return f"Could not parse target {target!r}. Pass `owner/repo#123` or a PR/issue URL."
        if chosen not in linked:
            return f"{_name(chosen)} is not linked to this conversation. Linked: {listing}."
        return chosen
    if in_reply_to is not None:
        pr = await _review_comment_pr(ctx, linked, in_reply_to)
        if pr is None:
            return (
                f"Review comment {in_reply_to} was not found in the linked repos "
                f"({listing}). `github_pr_summary` lists each thread's comment_id."
            )
        if pr not in linked:
            return (
                f"Review comment {in_reply_to} is on {_name(pr)}, which is not "
                f"linked to this conversation. Linked: {listing}."
            )
        return pr
    if len(linked) > 1:
        return (
            f"This conversation is linked to several GitHub PRs/issues: {listing}. "
            "Nothing was posted. Pass `target` naming the one to comment on, usually "
            "the one the comment you are answering was left on."
        )
    return linked[0]


def _posted_text(target: GithubTarget, response: httpx.Response) -> str:
    """Where the comment landed, so a misroute is visible."""
    try:
        url = (response.json() or {}).get("html_url")
    except ValueError:
        url = None
    return f"Commented on {_name(target)}" + (f": {url}" if url else ".")


async def _github_attached(ctx: ToolContext) -> bool:
    return bool(await github_targets(ctx))


_THREADS_QUERY = """query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$number){
      reviewThreads(first:100){ nodes {
        id isResolved viewerCanResolve
        comments(first:100){ nodes { databaseId } }
        last: comments(last:1){ nodes { viewerDidAuthor author { login } } }
      } }
    }
  }
}"""


async def _review_threads(ctx: ToolContext, target: GithubTarget) -> httpx.Response:
    """The PR's review threads, over GraphQL since REST does not expose them."""
    return await ctx.upstream.request(
        "POST",
        "graphql",
        json={
            "query": _THREADS_QUERY,
            "variables": {"owner": target.owner, "repo": target.repo, "number": target.number},
        },
    )


def _thread_with(response: httpx.Response, comment_id: int) -> dict | None:
    """The thread in a `_review_threads` response that contains `comment_id`."""
    threads = (
        ((((response.json() or {}).get("data") or {}).get("repository") or {}).get("pullRequest") or {})
        .get("reviewThreads", {})
        .get("nodes")
        or []
    )
    for thread in threads:
        ids = [c.get("databaseId") for c in (thread.get("comments", {}).get("nodes") or [])]
        if comment_id in ids:
            return thread
    return None


async def _thread_is_resolved(
    ctx: ToolContext, target: GithubTarget, comment_id: int
) -> bool:
    """Whether the review thread containing `comment_id` is resolved; fails open so the reply still posts."""
    try:
        response = await _review_threads(ctx, target)
        if not 200 <= response.status_code < 300:
            return False
        thread = _thread_with(response, comment_id)
        return thread is not None and thread.get("isResolved") is True
    except Exception:
        logger.warning(
            "could not check whether the review thread is resolved; posting anyway",
            extra={"comment_id": comment_id},
            exc_info=True,
        )
        return False


@gate(_github_attached)
@mcp.tool
async def github_comment(
    body: str,
    in_reply_to: int | None = None,
    target: str | None = None,
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Post a comment on one of THIS conversation's GitHub PRs/issues.

    `target` (`owner/repo#123` or a PR/issue URL) names which linked PR/issue to post
    on. It is required when the conversation has several, and should be the one the
    comment you are answering was left on. Pass `in_reply_to` (a review-comment id) to
    reply within a PR review thread; its PR is found from the id. Omit it for a
    PR-level comment. Returns the real result and the posted comment's URL.
    """
    resolved = await _comment_target(ctx, target, in_reply_to)
    if isinstance(resolved, str):
        return ToolResult.error(resolved)
    if in_reply_to is not None:
        # GitHub sends no webhook when a human resolves a review thread, so a late reply could land on a closed one.
        if await _thread_is_resolved(ctx, resolved, in_reply_to):
            return ToolResult.error(
                f"That review thread (comment {in_reply_to}) has been RESOLVED, so the "
                "reply was not posted — it would be noise on a closed conversation. If "
                "you still need to say something, post it as a PR-level comment "
                "(github_comment without in_reply_to)."
            )
    base = f"repos/{resolved.owner}/{resolved.repo}"
    path = (
        f"{base}/pulls/{resolved.number}/comments/{in_reply_to}/replies"
        if in_reply_to is not None
        else f"{base}/issues/{resolved.number}/comments"
    )
    response = await ctx.upstream.request("POST", path, json={"body": body})
    return ToolResult.from_upstream(response, success_text=_posted_text(resolved, response))


_RESOLVE = """mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}"""


@gate(_github_attached)
@mcp.tool
async def github_resolve_thread(
    comment_id: int,
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Resolve a review thread on one of THIS conversation's PRs, once you've answered it.

    Branch rules often REQUIRE every thread resolved before merging, even after an
    approval; github_pr_summary says when. `comment_id` is any comment in the thread
    (github_pr_summary lists them). Only a thread whose LAST comment is yours can be
    resolved: reply first (and push the fix), so the reviewer sees the answer. A thread
    where the reviewer spoke last is theirs to resolve.
    """
    target = await _comment_target(ctx, None, comment_id)
    if isinstance(target, str):
        return ToolResult.error(target)
    response = await _review_threads(ctx, target)
    if not 200 <= response.status_code < 300:
        return ToolResult.from_upstream(response, success_text="")
    thread = _thread_with(response, comment_id)
    if thread is None:
        return ToolResult.error(
            f"No review thread on {_name(target)} contains comment {comment_id}. "
            "github_pr_summary lists each thread's comment_id."
        )
    if thread.get("isResolved"):
        return ToolResult.ok(f"The thread with comment {comment_id} is already resolved.")
    last = ((thread.get("last") or {}).get("nodes") or [{}])[0]
    if last.get("viewerDidAuthor") is not True:
        who = ((last.get("author") or {}).get("login")) or "the reviewer"
        return ToolResult.error(
            f"Not resolved: @{who} has the last word in that thread, so it is theirs to "
            f"resolve. Reply with github_comment(body, in_reply_to={comment_id}) (and push "
            "any fix it asks for), then resolve it, or ask them to."
        )
    if not thread.get("viewerCanResolve"):
        return ToolResult.error(
            "Not resolved: GitHub does not let this identity resolve that thread. "
            "Ask the reviewer or a maintainer to resolve it."
        )
    response = await ctx.upstream.request(
        "POST", "graphql", json={"query": _RESOLVE, "variables": {"id": thread.get("id")}}
    )
    errors = _graphql_errors(response)
    if errors:
        return ToolResult.error(f"GitHub refused to resolve the thread: {errors}")
    return ToolResult.from_upstream(
        response, success_text=f"Resolved the thread with comment {comment_id} on {_name(target)}."
    )


def _graphql_errors(response: httpx.Response) -> str:
    """A 200 GraphQL response's error messages, joined; "" when there are none."""
    if not 200 <= response.status_code < 300:
        return ""
    try:
        errors = (response.json() or {}).get("errors") or []
    except ValueError:
        return ""
    return "; ".join(e.get("message", "") for e in errors)


_PR_TYPES = ("pr", "pull", "pulls", "pull_request", "pull_requests")
_ISSUE_TYPES = ("issue", "issues")


def _pr_target_from_link(link: dict) -> GithubTarget | None:
    """A link's target unless the link is known to be an issue."""
    if resource_type_is(str(link.get("resourceType") or ""), truthy=_ISSUE_TYPES, falsy=_PR_TYPES):
        return None
    if "/issues/" in (link.get("url") or ""):
        return None
    return _target_from_link(link)


async def github_pr_target(ctx: ToolContext) -> GithubTarget | None:
    """The conversation's oldest linked PR, skipping linked issues."""
    return first_target(await ctx.links.list(), SOURCE, _pr_target_from_link)


@mcp.tool
async def github_pr_summary(
    pr: str | None = None,
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """One-call status of a GitHub pull request. Check it before reporting on a PR.

    Shows state (open/merged/closed), DRAFT status, mergeability and conflicts, the
    review decision (who approved, who requested changes, who is still requested), CI
    on the head commit (failing and pending checks named), the comment count, and
    review threads. Each UNRESOLVED thread is listed with its comment_id, which
    github_comment takes as `in_reply_to`. It ends with the Blockers: each says
    whether the branch rules require it, how to clear it, and who can. Clear the
    ones marked [you], e.g. resolve answered threads with github_resolve_thread.

    Use it to keep track of your own PRs: before marking a draft ready for review,
    before saying a PR is done or green, and when picking work back up.

    `pr` is a PR URL or `owner/repo#123`. Omit it for the PR this conversation is
    linked to.
    """
    if pr:
        target = parse_github_resource_id(pr.strip())
        if target is None:
            return ToolResult.error(
                f"Could not parse {pr!r} as a GitHub PR. Pass a PR URL "
                "(https://github.com/owner/repo/pull/123) or `owner/repo#123`."
            )
    else:
        target = await github_pr_target(ctx)
        if target is None:
            return ToolResult.error(
                "This conversation has no linked GitHub PR. Pass `pr` explicitly, as a "
                "PR URL or `owner/repo#123`."
            )
    return await fetch_pr_summary(ctx.upstream, target)


@mcp.tool
async def github_attachment(ref: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Fetch a file attached to a GitHub issue, PR, comment or review.

    `ref` is a `gh:…` ref from the "Attachments" list of a forwarded GitHub message.
    An image comes back for you to look at, a text file inline, and a binary file as a
    curl command that saves it under /workspace/uploads. Fetch the screenshots on an
    issue before working on it.
    """
    github_host = GitHubSettings().github_host

    async def download(client):
        return await attachments.fetch(
            ref, lambda path, headers: ctx.upstream.request("GET", path, headers=headers), client,
            github_host=github_host, max_bytes=MAX_FILE_BYTES,
        )

    return await attachment_tool(download)


def github_mcp_server() -> FastMCP:
    return mcp
