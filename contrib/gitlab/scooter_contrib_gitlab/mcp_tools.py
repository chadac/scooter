"""GitLab's AGENT TOOL — comment on the conversation's MR/issue.

Moved here from the agent-host by issue #700. contrib/gitlab was already declaring
`ui.tools.gitlab_comment` — UI metadata for a tool it neither owned nor gated — so
disabling the contrib removed its chip, icon, card and broker route and left the tool
registered, firing at a route that now 404s. That asymmetry is what this closes.
"""

from __future__ import annotations

from urllib.parse import quote

from fastmcp import FastMCP

from scooter_broker_lib.links import first_target, ref_of, resource_type_is
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate
from scooter_broker_lib.refs import GitlabTarget, parse_gitlab_url

mcp = FastMCP(name="gitlab")

SOURCE = "gitlab"

# Each writer spells the type differently: the webhooks handler writes
# "merge_request", the broker's auto-link writes "mr".
_MR_TYPES = ("merge_request", "merge_requests", "mr")
_ISSUE_TYPES = ("issue", "issues")


def _target_from_link(link: dict) -> GitlabTarget | None:
    ref = ref_of(link)
    mr_iid = ref.get("mrIid")
    iid = mr_iid or ref.get("iid")
    project_id = ref.get("projectId")
    if not project_id or not iid:
        return parse_gitlab_url(link.get("url"))
    # resourceType decides the ENDPOINT. An issue link whose iid landed in `mrIid`
    # (what webhooks wrote before #563) must NOT comment on the merge request of that
    # number. An unrecognised spelling falls back to which ref field carried the iid.
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
    # The upstream is the BARE host, so the tool uses the full api/v4 path — the same
    # path the raw proxy route takes, minus the /gitlab prefix. The project path is
    # URL-encoded, which GitLab accepts in place of the numeric id.
    base = f"api/v4/projects/{quote(target.project_id, safe='')}/{kind}/{target.iid}"
    path = f"{base}/discussions/{quote(discussion_id, safe='')}/notes" if discussion_id else f"{base}/notes"
    response = await ctx.upstream.request("POST", path, json={"body": body})
    return ToolResult.from_upstream(
        response,
        success_text=f"Commented on the GitLab {'MR' if target.is_mr else 'issue'}.",
    )


def gitlab_mcp_server() -> FastMCP:
    return mcp
