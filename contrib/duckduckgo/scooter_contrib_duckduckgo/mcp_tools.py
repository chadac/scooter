"""DuckDuckGo's AGENT TOOL — `duckduckgo_web_search`. Keyless, and best-effort.

Reads DDG's no-JavaScript results page, because DDG has no results API. Two things here
look removable and are not:

  * the browser User-Agent is REQUIRED — the page refuses a programmatic one;
  * a page with no hits is a FAILURE unless DDG itself said "no results"
    (`html_results.classify`), because both rate-limiting and a restyle arrive as a 200
    with nothing in it.

Why (including why this is not the DuckDuckGo tool PR #698 removed): PR #707.
"""

from __future__ import annotations

from fastmcp import FastMCP

from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult
from scooter_broker_lib.search import search_result, upstream_failure

from .html_results import classify, hits_from_html

mcp = FastMCP(name="duckduckgo")

PROVIDER = "duckduckgo"
UPSTREAM = "https://html.duckduckgo.com"
SEARCH_PATH = "html/"

# Required, not decorative: the no-JS page refuses a programmatic user agent. Pinned
# here rather than left to a client default, which could change what DDG serves us.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# Region-neutral. Without it DDG localizes by egress IP, so the same query answers
# differently per cluster — something the agent reading the results cannot account for.
REGION = "wt-wt"


@mcp.tool
async def duckduckgo_web_search(query: str, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Search the web with DuckDuckGo and get ranked results (title, URL, snippet).

    Needs no API key, so a deployment may have this and nothing else. It is also the
    least reliable search tool here: it reads DuckDuckGo's public results page, so it can
    be rate-limited — reported as a FAILURE, not as an empty web. If that happens prefer
    another `*_web_search` tool if your list has one, or `web_fetch` on a URL you already
    know; repeating the query will be refused too.
    """
    # NOT attachment-gated: there is no resource to be attached to. The gate is
    # `duckduckgo_enabled` (broker_provider.py).
    text = query.strip()
    if not text:
        return ToolResult.error("`query` is required — pass the text to search for.")

    response = await ctx.upstream.request(
        "GET",
        SEARCH_PATH,
        params={"q": text, "kl": REGION},
        headers={"User-Agent": BROWSER_USER_AGENT, "Accept": "text/html"},
    )
    failure = upstream_failure(response, provider=PROVIDER)
    if failure is not None:
        return failure

    page = response.text
    hits = hits_from_html(page)
    if hits:
        return search_result(hits, query=text, provider=PROVIDER)

    outcome = classify(page)
    if outcome == "empty":
        # DDG said so itself, so this is a successful search of a web that had nothing.
        return search_result([], query=text, provider=PROVIDER)
    if outcome == "blocked":
        return ToolResult.error(
            f"duckduckgo_web_search FAILED: DuckDuckGo served its bot-check page instead "
            f'of results for "{text}". This provider reads the keyless HTML page, so it '
            "is rate-limited per source address and this deployment has hit the limit. "
            "Retrying the same query will not help — use another search tool if one is "
            "listed, or `web_fetch` on a URL you already know, and say that search was "
            "rate-limited."
        )
    return ToolResult.error(
        f'duckduckgo_web_search FAILED: DuckDuckGo answered for "{text}" with a page '
        "holding neither results nor its own 'no results' notice, which means the page's "
        "shape changed and this provider can no longer read it. Reported as a failure "
        "rather than as an empty result set ON PURPOSE — the web is not empty, this "
        "scraper is broken. Worth reporting to whoever runs this deployment."
    )


def duckduckgo_mcp_server() -> FastMCP:
    """The server the provider factory hands to `McpTools`."""
    return mcp
