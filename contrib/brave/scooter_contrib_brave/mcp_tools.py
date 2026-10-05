"""Brave's AGENT TOOL — `brave_web_search`.

THE KEY IS A HEADER, NEVER A QUERY PARAM: a key in a URL is copied into every access log
and proxy trace it passes. Declared as the credential's kind in `broker_provider.py`, so
this file never holds it and cannot put it anywhere.

Named for its provider so sibling search contribs (kagi, duckduckgo) can be enabled at
the same time. Why: issue #700, PR #707.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult
from scooter_broker_lib.search import MAX_RESULTS, hits_from, search_response, search_result

mcp = FastMCP(name="brave")

PROVIDER = "brave"
UPSTREAM = "https://api.search.brave.com"
# /res/v1/web/search is the plain results endpoint. The same-priced
# /res/v1/llm/context returns richer, pre-chunked snippets and is worth revisiting;
# this ports what #698 shipped rather than changing the response shape in the move.
SEARCH_PATH = "res/v1/web/search"


@mcp.tool
async def brave_web_search(query: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Search the web with Brave and get ranked results (title, URL, snippet).

    An independent index (Brave's own crawl), good for finding a fact and for picking a
    canonical URL to pass to `web_fetch`. If your tool list has other `*_web_search`
    tools they are other indexes over the same web: use ONE, and only try another if
    this one fails or returns nothing useful.

    A failure is returned to you with the real HTTP status and the provider's body
    verbatim — a 401 or 429 means this deployment's search key is bad or out of quota,
    so report it rather than retrying the query.
    """
    # NOT attachment-gated, unlike a provider's reply tools: there is no resource to be
    # attached to. The gate for search is `enabled` — no key ⇒ no provider ⇒ the agent
    # is never shown this tool. See broker_provider.py.
    text = query.strip()
    if not text:
        return ToolResult.error("`query` is required — pass the text to search for.")

    response = await ctx.upstream.request(
        "GET",
        SEARCH_PATH,
        params={"q": text, "count": MAX_RESULTS},
        headers={"Accept": "application/json"},
    )
    body, failure = search_response(response, provider=PROVIDER)
    if failure is not None:
        return failure

    rows = (body.get("web") or {}).get("results") or []
    return search_result(
        hits_from(rows, title="title", url="url", snippet="description"),
        query=text,
        provider=PROVIDER,
    )


def brave_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
