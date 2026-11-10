"""GitLab's agent tools: comment on the conversation's MR or issue, summarise an MR, and fetch an attachment."""

from __future__ import annotations

from urllib.parse import quote

from fastmcp import FastMCP

from scooter_broker_lib.attachments import attachment_tool
from scooter_broker_lib.links import first_target, ref_of, resource_type_is
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate
from scooter_broker_lib.refs import GitlabTarget, parse_gitlab_resource_id

from scooter_lib.attachments import MAX_FILE_BYTES

from . import attachments
from .mr_summary import fetch_mr_summary

mcp = FastMCP(name="gitlab")

SOURCE = "gitlab"

# Each writer spells the type differently.
_MR_TYPES = ("merge_request", "merge_requests", "mr")
_ISSUE_TYPES = ("issue", "issues")


def _target_from_link(link: dict) -> GitlabTarget | None:
    ref = ref_of(link)
    mr_iid = ref.get("mrIid")
    iid = mr_iid or ref.get("iid")
    project_id = ref.get("projectId")
    if not project_id or not iid:
        return parse_gitlab_resource_id(link.get("url") or "")
    # resourceType decides the endpoint; an unrecognised spelling falls back to which ref field carried the iid.
    is_mr = resource_type_is(
        str(link.get("resourceType") or ""), truthy=_MR_TYPES, falsy=_ISSUE_TYPES
    )
    if is_mr is None:
        is_mr = mr_iid is not None
    return GitlabTarget(project_id=project_id, iid=str(iid), is_mr=is_mr)


async def gitlab_target(ctx: ToolContext) -> GitlabTarget | None:
    return first_target(await ctx.links.list(), SOURCE, _target_from_link)


async def _gitlab_attached(ctx: ToolContext) -> bool:
    return await gitlab_target(ctx) is not None


@gate(_gitlab_attached)
@mcp.tool
async def gitlab_comment(
    body: str,
    discussion_id: str | None = None,
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Post a comment on THIS conversation's GitLab merge request or issue.

    The project and iid are inferred. Pass `discussion_id` to reply within a review
    discussion. Returns the real GitLab result.
    """
    target = await gitlab_target(ctx)
    if target is None:
        return ToolResult.error(
            "Could not determine the GitLab MR/issue for this conversation — it has no "
            "gitlab link with a project + iid. Use the broker's /gitlab proxy with an "
            "explicit project + iid instead."
        )
    kind = "merge_requests" if target.is_mr else "issues"
    # The upstream is the bare host, and GitLab accepts the URL-encoded project path in place of the numeric id.
    base = f"api/v4/projects/{quote(target.project_id, safe='')}/{kind}/{target.iid}"
    path = f"{base}/discussions/{quote(discussion_id, safe='')}/notes" if discussion_id else f"{base}/notes"
    response = await ctx.upstream.request("POST", path, json={"body": body})
    return ToolResult.from_upstream(
        response,
        success_text=f"Commented on the GitLab {'MR' if target.is_mr else 'issue'}.",
    )


def _mr_target_from_link(link: dict) -> GitlabTarget | None:
    target = _target_from_link(link)
    return target if target is not None and target.is_mr else None


async def gitlab_mr_target(ctx: ToolContext) -> GitlabTarget | None:
    """The conversation's oldest linked MR, skipping linked issues."""
    return first_target(await ctx.links.list(), SOURCE, _mr_target_from_link)


@mcp.tool
async def gitlab_mr_summary(
    mr: str | None = None,
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """One-call status of a GitLab merge request. Check it before reporting on an MR.

    Shows state (open/merged/closed), DRAFT status, GitLab's detailed merge status and
    conflicts, approvals (who approved, how many are still required, the assigned
    reviewers), the head pipeline (failing and pending jobs named), the comment count,
    and resolvable threads. Each UNRESOLVED thread is listed with its discussion_id,
    which gitlab_comment takes. The last line lists what blocks the merge.

    Use it to keep track of your own MRs: before marking a draft ready, before saying
    an MR is done or green, and when picking work back up.

    `mr` is an MR URL or `group/project!123`. Omit it for the MR this conversation is
    linked to.
    """
    if mr:
        target = parse_gitlab_resource_id(mr.strip())
        if target is None or not target.is_mr:
            return ToolResult.error(
                f"Could not parse {mr!r} as a GitLab merge request. Pass an MR URL "
                "(https://gitlab.com/group/project/-/merge_requests/123) or "
                "`group/project!123`."
            )
    else:
        target = await gitlab_mr_target(ctx)
        if target is None:
            return ToolResult.error(
                "This conversation has no linked GitLab MR. Pass `mr` explicitly, as an "
                "MR URL or `group/project!123`."
            )
    return await fetch_mr_summary(ctx.upstream, target)


@mcp.tool
async def gitlab_attachment(ref: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Fetch a file attached to a GitLab comment, issue or MR description.

    `ref` is a `gl:…` ref from the "Attachments" list of a forwarded GitLab message.
    An image comes back for you to look at, a text file inline, and a binary file as a
    curl command that saves it under /workspace/uploads. Fetch the screenshots on an
    issue before working on it.
    """

    async def download(client):
        return await attachments.fetch(
            ref, lambda path: ctx.upstream.request("GET", path), client, max_bytes=MAX_FILE_BYTES,
        )

    return await attachment_tool(download)


def gitlab_mcp_server() -> FastMCP:
    return mcp
