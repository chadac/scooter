"""Live search over the official MCP registry."""

from __future__ import annotations

import time

import httpx

from .store import valid_spec

DEFAULT_URL = "https://registry.modelcontextprotocol.io/v0/servers"
_KINDS = frozenset({"npm", "pypi"})
MAX_RESULTS = 20
_TTL = 60.0
_CACHE_MAX = 128


def _entry(item: object) -> dict | None:
    """One result row, or None if nothing runs in a sandbox."""
    srv = item.get("server") if isinstance(item, dict) else None
    if not isinstance(srv, dict):
        return None
    packages = srv.get("packages")
    for pkg in packages if isinstance(packages, list) else []:
        if not isinstance(pkg, dict):
            continue
        kind = pkg.get("registryType")
        spec = pkg.get("identifier")
        transport = pkg.get("transport") or {}
        if kind not in _KINDS or not isinstance(spec, str) or not valid_spec(kind, spec):
            continue
        if not isinstance(transport, dict) or transport.get("type", "stdio") != "stdio":
            continue
        env = pkg.get("environmentVariables")
        # The runner can't set env vars; required ones block adding.
        needs_key = any(isinstance(v, dict) and v.get("isRequired") for v in env) if isinstance(env, list) else False
        return {
            "registry_name": str(srv.get("name") or "")[:200],
            "kind": kind,
            "spec": spec,
            "description": str(srv.get("description") or "")[:300],
            "needs_api_key": needs_key,
        }
    return None


class RegistrySearch:
    """Queries the registry, keeping each query's rows for a minute."""

    def __init__(self, url: str = DEFAULT_URL, client: httpx.AsyncClient | None = None) -> None:
        self._url = url
        self._client = client or httpx.AsyncClient(timeout=5.0)
        self._cache: dict[str, tuple[float, list[dict]]] = {}

    async def search(self, q: str) -> list[dict]:
        hit = self._cache.get(q)
        if hit and time.monotonic() - hit[0] < _TTL:
            return hit[1]
        r = await self._client.get(self._url, params={"search": q, "version": "latest", "limit": 50})
        r.raise_for_status()
        raw = r.json()
        items = raw.get("servers") if isinstance(raw, dict) else None
        seen: set[tuple[str, str]] = set()
        rows: list[dict] = []
        for item in items if isinstance(items, list) else []:
            e = _entry(item)
            # Forks repeat a package; keep the first of each.
            if e is not None and (e["kind"], e["spec"]) not in seen:
                seen.add((e["kind"], e["spec"]))
                rows.append(e)
        rows = rows[:MAX_RESULTS]
        if len(self._cache) >= _CACHE_MAX:
            self._cache.clear()
        self._cache[q] = (time.monotonic(), rows)
        return rows
