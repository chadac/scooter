"""Web search — the shared half of a search contrib's `<provider>_web_search` tool.

Providers differ in the request they make and the body they unpack; the result format,
the cap and how the outcomes are told apart live here, so enabling two providers gives a
deployment two indexes and one behaviour.

THE OUTCOMES MUST STAY DISTINCT, which is the whole lesson of the tool this replaced: a
failure carries the real status VERBATIM (an agent told "no results" retries the query,
one told "HTTP 401" reports a bad key), and "no results" is a success that names the
provider. Why: PR #698, issue #700, PR #707.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

from .mcp import ToolResult

if TYPE_CHECKING:
    import httpx

# Ten is the cap the agent is given, not a provider's page size. A model picks one or
# two urls to hand to `web_fetch`; a longer list spends context to no end.
MAX_RESULTS = 10


@dataclass(frozen=True)
class SearchHit:
    """One result, normalized across providers.

    `url` is required because a hit the agent cannot follow is not a result — it is
    what made Kagi's related-searches row (a `t: 1` row with a `list` and no url)
    render as a bogus hit before the filter that drops it.
    """

    title: str
    url: str
    snippet: str | None = None


def upstream_failure(response: "httpx.Response", *, provider: str) -> ToolResult | None:
    """`None` if the search call succeeded, else the failure to report VERBATIM.

    Split out of `search_response` for the provider that answers in HTML rather than
    JSON (`contrib/duckduckgo`). The provider is NAMED in the message: "brave returned
    429" tells the agent its key is out of quota; "search failed" does not.
    """
    if 200 <= response.status_code < 300:
        return None
    return ToolResult.error(
        f"web search FAILED via {provider} (HTTP {response.status_code}). "
        f"The service returned:\n{response.text}"
    )


def search_response(
    response: "httpx.Response", *, provider: str
) -> tuple[dict[str, Any], ToolResult | None]:
    """Decode a search response into `(body, failure)` — exactly one is meaningful.

    Separate from `ToolResult.from_upstream` because a search tool keeps going on
    success: it parses the body.

    A 200 whose body is not JSON AT ALL is a FAILURE, not an empty result set — a proxy
    error page or a captive portal answered, and calling that "no results" is the bug
    this file exists to prevent. A body that IS json but not an object is no results
    instead: the call worked and we understood nothing in it, which is what an API change
    looks like. Why: PR #698.
    """
    failure = upstream_failure(response, provider=provider)
    if failure is not None:
        return {}, failure
    if not response.content:
        return {}, None
    try:
        body = response.json()
    except (ValueError, json.JSONDecodeError):
        return {}, ToolResult.error(
            f"web search FAILED via {provider}: HTTP {response.status_code} with a body "
            f"that is not JSON, so nothing answered as the search API. It returned:\n"
            f"{response.text[:500]}"
        )
    return (body if isinstance(body, dict) else {}), None


def hits_from(rows: Iterable[dict], *, title: str, url: str, snippet: str) -> list[SearchHit]:
    """Unpack a provider's result rows by field name, dropping any row with no url.

    The providers agree on the SHAPE of a result and disagree only on what the three
    fields are called, so each one passes its own key names rather than writing the
    same loop. Falling back to the url as the title keeps a titleless row usable
    instead of rendering `- (https://…)`.
    """
    hits: list[SearchHit] = []
    for row in rows:
        link = (row.get(url) or "").strip()
        if not link:
            continue
        hits.append(SearchHit(title=(row.get(title) or link), url=link, snippet=row.get(snippet)))
        if len(hits) >= MAX_RESULTS:
            break
    return hits


def search_result(hits: Sequence[SearchHit], *, query: str, provider: str) -> ToolResult:
    """Render hits as the agent-facing text block.

    One `- title (url)` per line with the snippet indented beneath it, so a model can
    read the list and pick a url to pass to `web_fetch` — which is what search is for
    here. Not JSON: the model consumes this as text either way, and the brackets would
    only cost tokens.
    """
    if not hits:
        # Success, not an error: the query ran and the web had nothing. Named with the
        # provider so "nothing found" can be weighed against which index was asked.
        return ToolResult.ok(f'No results for "{query}" (via {provider}).')
    lines = [f'Results for "{query}":']
    for hit in hits[:MAX_RESULTS]:
        lines.append(f"- {hit.title} ({hit.url})")
        if hit.snippet:
            lines.append(f"  {hit.snippet}")
    return ToolResult.ok("\n".join(lines))
