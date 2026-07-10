"""Auto-linking: when an agent creates a PR / MR / issue THROUGH the broker's
http-proxy, associate it with the agent's conversation — no agent effort required.

The http-proxy already knows (a) the request path + method, (b) the upstream
response, and (c) the conversation id (from the SA token → Identity). A provider
(github/gitlab/jira) declares LinkRules for its own create endpoints; when a
matching request returns 2xx, the transport extracts the created resource and
POSTs it to the agent-host's /conversations/{id}/links. Provider-specific
knowledge (which paths, which response shape) stays in the providers; the
mechanism here is generic.

Best-effort throughout: a link that can't be built/posted is logged and dropped —
it must never break the proxied API call the agent actually made.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass

import httpx

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Link:
    """A resource to associate with a conversation (matches the agent-host
    POST /conversations/{id}/links body)."""

    source: str          # "github" | "gitlab" | "jira"
    resource_type: str   # "pr" | "mr" | "issue"
    url: str             # the human-visitable URL
    title: str | None = None


@dataclass(frozen=True)
class LinkRule:
    """Match a proxied create request and extract the created resource from the
    2xx response JSON. `method` + `path_pattern` (a regex matched against the
    proxied path, WITHOUT the /{provider}/ prefix) gate it; `extract` turns the
    parsed response body into a Link (or None to skip)."""

    method: str
    path_pattern: re.Pattern[str]
    extract: Callable[[dict], Link | None]

    def matches(self, method: str, path: str) -> bool:
        return method.upper() == self.method.upper() and self.path_pattern.search(path) is not None


def rule(method: str, path_regex: str, extract: Callable[[dict], Link | None]) -> LinkRule:
    return LinkRule(method=method, path_pattern=re.compile(path_regex), extract=extract)


def _links_url(agent_host_url: str, conversation_id: str) -> str:
    return f"{agent_host_url.rstrip('/')}/conversations/{conversation_id}/links"


async def post_link(agent_host_url: str, conversation_id: str, link: Link) -> None:
    """POST a link to the agent-host. Best-effort — never raises to the caller
    (used by the auto-link injector, where a failure must not break the proxy)."""
    if not agent_host_url or not conversation_id:
        return
    payload = {
        "source": link.source,
        "resourceType": link.resource_type,
        "url": link.url,
        "title": link.title,
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.post(_links_url(agent_host_url, conversation_id), json=payload)
        if resp.status_code >= 300:
            logger.warning("auto-link POST /links failed (%s) for %s: %s", resp.status_code, conversation_id, link.url)
        else:
            logger.info("auto-linked %s %s -> conversation %s", link.source, link.resource_type, conversation_id)
    except httpx.HTTPError as e:
        logger.warning("auto-link POST /links errored for %s: %s", conversation_id, e)


async def create_link(agent_host_url: str, conversation_id: str, link: Link) -> None:
    """Attach a link to the conversation, RAISING on failure. Used by the broker's
    explicit POST /link endpoint (an agent asking to link something) — unlike the
    best-effort injector, the caller wants to know if it didn't take."""
    if not agent_host_url:
        raise RuntimeError("agent-host URL not configured (AGENT_HOST_URL)")
    if not conversation_id:
        raise RuntimeError("no conversation for this identity — cannot attach a link")
    payload = {
        "source": link.source,
        "resourceType": link.resource_type,
        "url": link.url,
        "title": link.title,
    }
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(_links_url(agent_host_url, conversation_id), json=payload)
        resp.raise_for_status()


async def list_links(agent_host_url: str, conversation_id: str) -> list[dict]:
    """List the conversation's current links (agent-host GET /links)."""
    if not agent_host_url or not conversation_id:
        return []
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(_links_url(agent_host_url, conversation_id))
        resp.raise_for_status()
        data = resp.json()
    return data.get("links", []) if isinstance(data, dict) else []
