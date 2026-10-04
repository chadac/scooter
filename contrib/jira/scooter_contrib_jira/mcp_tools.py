"""Jira's AGENT TOOL — comment on the conversation's issue.

Moved here from the agent-host by issue #700.
"""

from __future__ import annotations

from urllib.parse import quote

from fastmcp import FastMCP

from scooter_broker_lib.links import first_target, ref_of
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate
from scooter_broker_lib.refs import JiraTarget, parse_jira_url

mcp = FastMCP(name="jira")

SOURCE = "jira"


def _target_from_link(link: dict) -> JiraTarget | None:
    key = ref_of(link).get("issueKey")
    if key:
        return JiraTarget(issue_key=str(key))
    return parse_jira_url(link.get("url"))


async def jira_target(ctx: ToolContext) -> JiraTarget | None:
    return first_target(await ctx.links.list(), SOURCE, _target_from_link)


async def _jira_attached(ctx: ToolContext) -> bool:
    return await jira_target(ctx) is not None


@gate(_jira_attached)
@mcp.tool
async def jira_comment(body: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Post a comment on THIS conversation's Jira issue.

    The issue key is inferred. Returns the real Jira result. Prefer this over a raw
    broker call.
    """
    target = await jira_target(ctx)
    if target is None:
        return ToolResult.error(
            "Could not determine the Jira issue for this conversation — it has no jira "
            "link with an issue key. Use the broker's /jira proxy with an explicit key "
            "instead."
        )
    # REST v2, not v3: v2 accepts a plain-text `body` where v3 requires ADF. The
    # upstream already includes /ex/jira/{cloud_id}, so the path starts at rest/.
    path = f"rest/api/2/issue/{quote(target.issue_key, safe='')}/comment"
    response = await ctx.upstream.request("POST", path, json={"body": body})
    return ToolResult.from_upstream(response, success_text="Commented on the Jira issue.")


def jira_mcp_server() -> FastMCP:
    return mcp
