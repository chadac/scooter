"""Kagi's AGENT TOOL — `kagi_web_search`.

An alternative to `contrib/brave` that can also run ALONGSIDE it: the tool carries its
provider's name, so enabling both puts two search tools in the agent's list rather than
two providers fighting over one name. The first cut of this contrib named the tool
`web_search` and made the two mutually exclusive; limiting the agent to one index was
an artifact of that naming, not a requirement. Why: review of PR #707.

WHEN TO PICK THIS ONE: better human-facing ranking, at $12/1k requests with no free
tier and a paid Kagi account required — against brave's $5/1k with $5 granted monthly.
An LLM reranking the results erases much of the quality difference, so brave is the
default recommendation and this exists for deployments that already pay for Kagi.
Why: PR #698.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult
from scooter_broker_lib.search import MAX_RESULTS, hits_from, search_response, search_result

mcp = FastMCP(name="kagi")

PROVIDER = "kagi"
UPSTREAM = "https://kagi.com"
SEARCH_PATH = "api/v1/search"

# Kagi's rows are TYPED, and this filter is load-bearing: `t: 0` is a search result,
# while `t: 1` is a related-searches row carrying a `list` and no url. Without the
# filter that row renders as a bogus hit the agent cannot follow. Why: PR #698.
RESULT_ROW = 0


@mcp.tool
async def kagi_web_search(query: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Search the web with Kagi and get ranked results (title, URL, snippet).

    Kagi ranks for humans rather than for ad load, so it is often the better index for
    a research question. If your tool list has other `*_web_search` tools they are
    other indexes over the same web: use ONE, and only try another if this one fails or
    returns nothing useful.

    A failure is returned to you with the real HTTP status and the provider's body
    verbatim — a 401 or a quota error means this deployment's search key is bad or
    exhausted, so report it rather than retrying the query.
    """
    # NOT attachment-gated: there is no resource to be attached to. Search's gate is
    # `enabled` — no key ⇒ no provider ⇒ the agent never sees this tool.
    text = query.strip()
    if not text:
        return ToolResult.error("`query` is required — pass the text to search for.")

    response = await ctx.upstream.request(
        "GET", SEARCH_PATH, params={"q": text, "limit": MAX_RESULTS}
    )
    body, failure = search_response(response, provider=PROVIDER)
    if failure is not None:
        return failure

    rows = body.get("data") or []
    results = [row for row in rows if isinstance(row, dict) and row.get("t") == RESULT_ROW]
    return search_result(
        hits_from(results, title="title", url="url", snippet="snippet"),
        query=text,
        provider=PROVIDER,
    )


def kagi_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
