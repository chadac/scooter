"""A web-search MCP server that reaches its provider THROUGH THE BROKER.

Shared by the search contribs (brave, kagi); the provider-specific parts arrive as
env, so this file holds no vendor logic beyond parsing each one's result shape.

WHY THE BROKER and not the vendor API directly: this process runs inside the
agent's sandbox, where the agent has a root shell. A key in this unit's
environment is a key the agent can read, which is exactly what the broker exists
to prevent. So the search key lives in the broker, and this server calls
`$BROKER_URL/<provider>/...` with the pod's own projected token.

Protocol: JSON-RPC 2.0 over stdio (MCP). `mcpServers.<name>.stdioCommand` bridges
it to streamable HTTP via mcp-proxy, so nothing here speaks HTTP to the agent.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

PROTOCOL_VERSION = "2024-11-05"

PROVIDER = os.environ.get("SEARCH_PROVIDER", "")
TOOL_NAME = os.environ.get("SEARCH_TOOL_NAME", "web_search")
TOOL_TITLE = os.environ.get("SEARCH_TOOL_TITLE", "Search the web")
MAX_RESULTS = int(os.environ.get("SEARCH_MAX_RESULTS", "10"))
TIMEOUT_S = 15


def _broker_get(path: str) -> tuple[int, str]:
    """GET $BROKER_URL/<path> with the pod's broker token. Returns (status, body).

    Never raises for an HTTP error status: the caller reports the real status and
    body to the agent verbatim, so a 401 reads as a 401 and not as "no results".
    """
    base = (os.environ.get("BROKER_URL") or "").rstrip("/")
    if not base:
        return 0, "BROKER_URL is not set in this sandbox — the broker is not wired."
    token_path = os.environ.get("BROKER_TOKEN_PATH", "/var/run/secrets/broker/token")
    try:
        with open(token_path, encoding="utf-8") as fh:
            token = fh.read().strip()
    except OSError as exc:
        return 0, f"could not read the broker token at {token_path}: {exc}"

    req = urllib.request.Request(
        f"{base}/{path.lstrip('/')}",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        # The broker echoes the upstream body; keep it whole.
        return exc.code, exc.read().decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError) as exc:
        return 0, f"could not reach the broker: {exc}"


def _hits_brave(doc: dict) -> list[dict]:
    return [
        {
            "title": r.get("title") or r.get("url"),
            "url": r.get("url"),
            "snippet": r.get("description"),
        }
        for r in (doc.get("web", {}).get("results") or [])
        if r.get("url")
    ]


def _hits_kagi(doc: dict) -> list[dict]:
    # Kagi rows are typed: t == 0 is a result; t == 1 is a related-searches row
    # carrying a `list` and no url. Without the filter that row renders as a hit.
    return [
        {
            "title": r.get("title") or r.get("url"),
            "url": r.get("url"),
            "snippet": r.get("snippet"),
        }
        for r in (doc.get("data") or [])
        if r.get("t") == 0 and r.get("url")
    ]


# provider -> (broker path template, result parser)
PROVIDERS = {
    "brave": ("brave/res/v1/web/search?q={q}&count={n}", _hits_brave),
    "kagi": ("kagi/api/v1/search?q={q}&limit={n}", _hits_kagi),
}


def run_search(query: str) -> tuple[str, bool]:
    """Return (agent-facing text, is_error)."""
    spec = PROVIDERS.get(PROVIDER)
    if spec is None:
        return f"{TOOL_NAME}: unknown SEARCH_PROVIDER {PROVIDER!r}.", True
    path_tmpl, parse = spec

    path = path_tmpl.format(q=urllib.parse.quote(query), n=MAX_RESULTS)
    status, body = _broker_get(path)
    if status == 0:
        return f"{TOOL_NAME} failed: {body}", True
    if not 200 <= status < 300:
        # Verbatim status + body: the broker 404s /<provider>/* when the provider
        # is not configured, and that is the single most useful thing to say.
        return f"{TOOL_NAME} FAILED (HTTP {status}) from the broker:\n{body}", True
    try:
        doc = json.loads(body)
    except json.JSONDecodeError:
        return f"{TOOL_NAME}: could not parse the provider response:\n{body[:2000]}", True

    hits = parse(doc)[:MAX_RESULTS]
    if not hits:
        return f'No results for "{query}" (via {PROVIDER}).', False
    lines = [f'Results for "{query}":']
    for h in hits:
        lines.append(f"- {h['title']} ({h['url']})")
        if h.get("snippet"):
            lines.append(f"  {h['snippet']}")
    return "\n".join(lines), False


TOOL_SCHEMA = {
    "name": TOOL_NAME,
    "title": TOOL_TITLE,
    "description": (
        f"Search the web via {PROVIDER} and get ranked results (title, URL, snippet). "
        "Good for finding facts and for picking a canonical URL to pass to web_fetch."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {"query": {"type": "string", "description": "The search query."}},
        "required": ["query"],
    },
}


def handle(req: dict) -> dict | None:
    """Map one JSON-RPC request to its reply, or None for a notification."""
    method = req.get("method")
    rid = req.get("id")

    if method == "initialize":
        result = {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": f"scooter-search-{PROVIDER}", "version": "0.0.0"},
        }
    elif method == "tools/list":
        result = {"tools": [TOOL_SCHEMA]}
    elif method == "tools/call":
        params = req.get("params") or {}
        if params.get("name") != TOOL_NAME:
            return _error(rid, -32602, f"unknown tool {params.get('name')!r}")
        query = (params.get("arguments") or {}).get("query")
        if not isinstance(query, str) or not query.strip():
            return _error(rid, -32602, "`query` is required and must be a non-empty string")
        text, is_error = run_search(query)
        result = {"content": [{"type": "text", "text": text}], "isError": is_error}
    elif method == "ping":
        result = {}
    elif rid is None:
        # A notification (e.g. notifications/initialized) takes no reply at all;
        # answering one is a protocol error, not a harmless extra.
        return None
    else:
        return _error(rid, -32601, f"method not found: {method}")

    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _error(rid: object, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps(_error(None, -32700, "parse error")), flush=True)
            continue
        reply = handle(req)
        if reply is not None:
            print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
