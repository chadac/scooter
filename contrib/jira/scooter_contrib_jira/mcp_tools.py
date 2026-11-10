"""Jira's agent tools: comment on the conversation's issue, and fetch an attachment."""

from __future__ import annotations

from urllib.parse import quote

from fastmcp import FastMCP

from scooter_broker_lib.attachments import attachment_tool
from scooter_broker_lib.links import first_target, ref_of
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult, gate
from scooter_broker_lib.refs import ISSUE_KEY_RE, JiraTarget, parse_jira_url
from scooter_lib.attachments import MAX_FILE_BYTES

from . import attachments

mcp = FastMCP(name="jira")

SOURCE = "jira"


def _target_from_link(link: dict) -> JiraTarget | None:
    key = ref_of(link).get("issueKey")
    if key:
        return JiraTarget(issue_key=str(key))
    # The browse-URL form first, then a bare key as jira's conversation_map stores it.
    raw = (link.get("url") or "").strip()
    if not raw:
        return None
    return parse_jira_url(raw) or (
        JiraTarget(issue_key=raw.upper()) if ISSUE_KEY_RE.match(raw) else None
    )


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
    # REST v2 accepts a plain-text `body` where v3 requires ADF; the upstream already includes /ex/jira/{cloud_id}.
    path = f"rest/api/2/issue/{quote(target.issue_key, safe='')}/comment"
    response = await ctx.upstream.request("POST", path, json={"body": body})
    return ToolResult.from_upstream(response, success_text="Commented on the Jira issue.")


@mcp.tool
async def jira_attachment(ref: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Fetch a file attached to a Jira issue.

    `ref` is a `jira:…` ref from the "Attachments" list of a forwarded Jira message.
    An image comes back for you to look at, a text file inline, and a binary file as a
    curl command that saves it under /workspace/uploads. Fetch the screenshots on an
    issue before working on it.
    """

    async def download(client):
        return await attachments.fetch(
            ref, lambda path: ctx.upstream.request("GET", path), client, max_bytes=MAX_FILE_BYTES,
        )

    return await attachment_tool(download)


def jira_mcp_server() -> FastMCP:
    return mcp
