"""GitHub's AGENT TOOL — comment on the conversation's PR/issue.

Moved here from the agent-host by issue #700. It was hardcoded there, so enabling or
disabling contrib/github did nothing to the agent's tool surface — and the broker never
learned which conversation the call was for, so a PR the agent created through a tool
was never auto-linked.

It also used to depend, invisibly, on the agent-host being listed in the broker's
APPROVER_SERVICE_ACCOUNTS — a setting that exists to let it relay a human's
approve/deny. On a deployment that never set it, `github_comment` returned
`403 not a sandbox SA` while everything else worked. Now the call never leaves the
broker and the conversation comes from the verified token, so that coupling is gone.
"""

from __future__ import annotations

import logging

from fastmcp import FastMCP

from scooter_broker_lib.links import first_target, ref_of
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate
from scooter_broker_lib.refs import GithubTarget, parse_github_resource_id

logger = logging.getLogger(__name__)

mcp = FastMCP(name="github")

SOURCE = "github"


def _target_from_link(link: dict) -> GithubTarget | None:
    """A link's target: the structured `ref` first, then its URL.

    The URL fallback is not an edge case — a link posted through the agent-host API
    (the broker's auto-link injector, `agent-broker link add`) carries only url+title,
    which is the majority of real rows.

    The resource-id parser is used rather than the URL one because it tries the
    short form FIRST and then falls back to the URL — so one call covers both an
    html_url link and a synthetic conversation_map row (routes.py `_resource_map`).

    COMPLETENESS IS PER LINK: all three of owner/repo/number come from the ref, or the
    ref is abandoned and the URL is parsed whole. Mixing them once produced an owner
    from one repo and a number from another — a comment on an unrelated PR.
    """
    ref = ref_of(link)
    owner, repo, number = ref.get("owner"), ref.get("repo"), ref.get("number")
    if owner and repo and number is not None:
        return GithubTarget(owner=owner, repo=repo, number=int(number))
    return parse_github_resource_id(link.get("url") or "")


async def github_target(ctx: ToolContext) -> GithubTarget | None:
    """The PR/issue this conversation is attached to, or None. Shared by the gate and
    the handler, so the tool is offered iff it could actually act."""
    return first_target(await ctx.links.list(), SOURCE, _target_from_link)


async def _github_attached(ctx: ToolContext) -> bool:
    return await github_target(ctx) is not None


async def _thread_is_resolved(
    ctx: ToolContext, target: GithubTarget, comment_id: int
) -> bool:
    """Is the review thread containing `comment_id` already resolved?

    FAILS OPEN — any error answers False, so the reply still posts. A missed reply is
    worse than a stale one: the human asked for it.

    GraphQL because the REST API does not expose thread resolution at all.
    """
    query = """query($owner:String!,$repo:String!,$number:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$number){
          reviewThreads(first:100){ nodes { isResolved comments(first:100){ nodes { databaseId } } } }
        }
      }
    }"""
    try:
        response = await ctx.upstream.request(
            "POST",
            "graphql",
            json={
                "query": query,
                "variables": {
                    "owner": target.owner,
                    "repo": target.repo,
                    "number": target.number,
                },
            },
        )
        if not 200 <= response.status_code < 300:
            return False
        threads = (
            (response.json() or {})
            .get("data", {})
            .get("repository", {})
            .get("pullRequest", {})
            .get("reviewThreads", {})
            .get("nodes")
            or []
        )
        for thread in threads:
            ids = [c.get("databaseId") for c in (thread.get("comments", {}).get("nodes") or [])]
            if comment_id in ids:
                return thread.get("isResolved") is True
        return False  # thread not found — post rather than swallow
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
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Post a comment on THIS conversation's GitHub PR/issue.

    owner/repo/number are inferred. Pass `in_reply_to` (a review-comment id) to reply
    within a PR review thread; omit it for a PR-level comment. Returns the real result.
    """
    target = await github_target(ctx)
    if target is None:
        return ToolResult.error(
            "Could not determine the GitHub PR/issue for this conversation — it has no "
            "github link with owner/repo/number. Use the broker's /github proxy with an "
            "explicit owner/repo/number instead."
        )
    if in_reply_to is not None:
        # GitHub sends NO webhook when a human resolves a review thread, so a reply the
        # agent was asked for minutes ago can land on a thread that is already closed,
        # which reads as noise on the PR. Check first.
        if await _thread_is_resolved(ctx, target, in_reply_to):
            return ToolResult.error(
                f"That review thread (comment {in_reply_to}) has been RESOLVED, so the "
                "reply was not posted — it would be noise on a closed conversation. If "
                "you still need to say something, post it as a PR-level comment "
                "(github_comment without in_reply_to)."
            )
    base = f"repos/{target.owner}/{target.repo}"
    path = (
        f"{base}/pulls/{target.number}/comments/{in_reply_to}/replies"
        if in_reply_to
        else f"{base}/issues/{target.number}/comments"
    )
    response = await ctx.upstream.request("POST", path, json={"body": body})
    return ToolResult.from_upstream(response, success_text="Commented on the GitHub PR/issue.")


def github_mcp_server() -> FastMCP:
    return mcp
