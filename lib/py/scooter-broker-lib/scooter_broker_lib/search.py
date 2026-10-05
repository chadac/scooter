"""Web search — the shared half of a search contrib's `<provider>_web_search` tool.

Every search contrib (brave, kagi, a third-party one) declares a tool named for itself
and differs only in the request it makes and the body it unpacks. What they must NOT
differ in is what the agent sees: the result format, the result cap, and how the
outcomes are told apart. Those live here, so a deployment that enables two providers
gets two indexes and one behaviour — and swapping providers changes the bill and the
ranking, never how a result or a failure reads.

The tool NAME is per-provider for a reason that is not cosmetic: names are flat and
global (broker/mcp/routes.py refuses to start on a duplicate), so one shared
`web_search` would have made the providers mutually exclusive — an artifact of the
name rather than a real constraint. Why: review of PR #707.

THE THREE OUTCOMES, which the implementation this replaces collapsed into one.
The agent-host's `web_search` used to call DuckDuckGo's Instant Answer API — a definitions endpoint,
not a web index — so a real query came back HTTP 200 with "no instant answer" and
search presented as AN EMPTY WEB rather than as the wrong API. Hence:

  * FAILED        — `upstream_failure`, carrying the verbatim status and body. A 401
                    from a bad key or a 429 from an exhausted quota must read as
                    itself; an agent told "no results" retries the query, while one
                    told "HTTP 401" reports a misconfiguration.
  * no results    — a successful search of a web that genuinely has nothing. NOT an
                    error, and named with the provider so the agent can judge it.
  * results       — rendered one `- title (url)` per line.

UNCONFIGURED is the fourth outcome and it is not here, because in the contrib model it
cannot reach a tool: a search provider with no key is `enabled=False`, so `web_search`
is never listed at all. The agent's instruction for that case ("no search tool in your
list ⇒ this deployment has no provider; use web_fetch on a known URL") is in
skills/agent-tools.md, where the same rule already covers every provider tool.

Why: issue #700 (tools belong to the contrib that owns the credential) and PR #698
(which established that the old provider was the bug).
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


def search_response(
    response: "httpx.Response", *, provider: str
) -> tuple[dict[str, Any], ToolResult | None]:
    """Decode a search response into `(body, failure)` — exactly one is meaningful.

    Separate from `ToolResult.from_upstream` because a search tool has to KEEP GOING on
    success: it parses the body. The failure branch is identical in spirit — the real
    status and the upstream body, unmodified — with the provider NAMED, because "brave
    returned 429" tells the agent its key is out of quota while "search failed" does
    not.

    A 200 whose body is not JSON AT ALL is also a failure, not an empty result set: it
    means something answered that was not the API — a proxy's error page, a captive
    portal — and reporting that as "no results" is precisely the bug that made the
    previous implementation look like an empty web. A body that IS json but not an
    object is treated as no results instead: the call worked and we simply understood
    nothing in it, which is what an API change looks like.
    """
    if not 200 <= response.status_code < 300:
        return {}, ToolResult.error(
            f"web_search FAILED via {provider} (HTTP {response.status_code}). "
            f"The service returned:\n{response.text}"
        )
    if not response.content:
        return {}, None
    try:
        body = response.json()
    except (ValueError, json.JSONDecodeError):
        return {}, ToolResult.error(
            f"web_search FAILED via {provider}: HTTP {response.status_code} with a body "
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
