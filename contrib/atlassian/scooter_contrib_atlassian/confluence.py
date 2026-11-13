"""Confluence's agent tools, calling the v2 API (v1 for CQL search) through the atlassian provider's policy."""

from __future__ import annotations

import re
from typing import Literal
from urllib.parse import quote

import httpx
from fastmcp import FastMCP
from pydantic import BaseModel

from scooter_broker_lib.autolink import Link, post_link
from scooter_broker_lib.links import first_target
from scooter_broker_lib.mcp import ToolContext, ToolContextDep, ToolResult

from .config import AtlassianSettings
from .storage import EditError, apply_edits, lossy_elements, markdown_to_storage, storage_to_markdown

mcp = FastMCP(name="confluence")

# The link source, also the atlassian contrib's `ui.sources` row.
SOURCE = "atlassian-confluence"

V2 = "wiki/api/v2"

Format = Literal["markdown", "storage"]

_PAGE_ID = re.compile(r"/pages/(\d+)|[?&]pageId=(\d+)")


class Edit(BaseModel):
    old: str
    new: str


def page_id(page: str) -> str | None:
    """A page id from a bare id or any page URL that carries one; tiny /x/ links don't."""
    page = page.strip()
    if page.isdigit():
        return page
    m = _PAGE_ID.search(page)
    return (m.group(1) or m.group(2)) if m else None


def page_url(page: dict, site_url: str = "") -> str | None:
    """The page's web URL, from the response's own base when present, else the configured site."""
    links = page.get("_links") or {}
    webui = links.get("webui")
    if not webui:
        return None
    base = links.get("base") or (f"{site_url.rstrip('/')}/wiki" if site_url else "")
    return f"{base}{webui}" if base else None


def page_link(page: dict, site_url: str = "") -> Link | None:
    url = page_url(page, site_url)
    return Link(source=SOURCE, resource_type="page", url=url, title=page.get("title")) if url else None


def _site() -> str:
    return AtlassianSettings().atlassian_site_url


def _to_storage(body: str, fmt: Format) -> str:
    return body if fmt == "storage" else markdown_to_storage(body)


def _failed(response: httpx.Response, hint: str = "") -> ToolResult:
    return ToolResult.error(
        f"Request FAILED (HTTP {response.status_code}). Confluence returned:\n{response.text}{hint}"
    )


def _bad_page(page: str) -> ToolResult:
    return ToolResult.error(
        f"{page!r} is not a page id or a page URL with one (…/pages/<id>/… or ?pageId=<id>). "
        "Open a tiny /x/ link in confluence_search or pass the numeric id."
    )


async def _get(ctx: ToolContext, pid: str) -> httpx.Response:
    return await ctx.upstream.request("GET", f"{V2}/pages/{pid}", params={"body-format": "storage"})


async def _linked_page(ctx: ToolContext) -> str | None:
    return first_target(await ctx.links.list(), SOURCE, lambda link: page_id(link.get("url") or ""))


@mcp.tool
async def confluence_search(cql: str, limit: int = 25, ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Search Confluence with CQL, e.g. `type = page AND space = ENG AND text ~ "runbook"`.

    Returns one line per result: id, title, space, last modified and URL. Read a page
    with confluence_get_page.
    """
    response = await ctx.upstream.request(
        "GET", "wiki/rest/api/search", params={"cql": cql, "limit": max(1, min(limit, 100))},
    )
    if not response.is_success:
        return _failed(response)
    data = response.json()
    base = (data.get("_links") or {}).get("base", "")
    lines = []
    for r in data.get("results", []):
        content = r.get("content") or {}
        space = (r.get("resultGlobalContainer") or {}).get("title", "")
        url = f"{base}{r['url']}" if r.get("url") else ""
        lines.append(" | ".join(str(x) for x in (
            content.get("id", ""), content.get("type", ""), r.get("title") or content.get("title", ""),
            space, r.get("friendlyLastModified") or r.get("lastModified", ""), url,
        )))
    total = data.get("totalSize", len(lines))
    head = f"{len(lines)} of {total} results (id | type | title | space | modified | url):"
    return ToolResult.ok("\n".join([head, *lines]) if lines else "No results.")


@mcp.tool
async def confluence_get_page(page: str, format: Format = "markdown", ctx: ToolContext = ToolContextDep) -> ToolResult:
    """Read a Confluence page by id or URL, as Markdown or as raw storage XHTML.

    The header gives the title, id, version and URL. Markdown drops macros, layouts
    and mentions; the header lists any the page has, and `format="storage"` shows them.
    """
    pid = page_id(page)
    if pid is None:
        return _bad_page(page)
    response = await _get(ctx, pid)
    if not response.is_success:
        return _failed(response)
    data = response.json()
    storage = ((data.get("body") or {}).get("storage") or {}).get("value", "")
    head = [
        f"# {data.get('title', '')}",
        f"id {data.get('id', pid)}, version {(data.get('version') or {}).get('number', '?')}, "
        f"{page_url(data, _site()) or 'no web URL'}",
    ]
    if format == "storage":
        return ToolResult.ok("\n".join([*head, "", storage]))
    lost = lossy_elements(storage)
    if lost:
        head.append(f"Not shown in Markdown: {', '.join(lost)}. Use format=\"storage\" to see or edit them.")
    return ToolResult.ok("\n".join([*head, "", storage_to_markdown(storage)]))


@mcp.tool
async def confluence_create_page(
    space: str,
    title: str,
    body: str,
    parent: str | None = None,
    format: Format = "markdown",
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Create a Confluence page in a space (by key, e.g. ENG), optionally under a parent page (id or URL).

    `body` is Markdown unless `format="storage"`. The new page is linked to this
    conversation.
    """
    payload: dict = {"status": "current", "title": title,
                     "body": {"representation": "storage", "value": _to_storage(body, format)}}
    if parent:
        parent_id = page_id(parent)
        if parent_id is None:
            return _bad_page(parent)
        payload["parentId"] = parent_id
    spaces = await ctx.upstream.request("GET", f"{V2}/spaces", params={"keys": space})
    if not spaces.is_success:
        return _failed(spaces)
    found = spaces.json().get("results") or []
    if not found:
        return ToolResult.error(f"No Confluence space with key {space!r} (or the app can't see it).")
    payload["spaceId"] = found[0]["id"]
    response = await ctx.upstream.request("POST", f"{V2}/pages", json=payload)
    if not response.is_success:
        return _failed(response)
    created = response.json()
    link = page_link(created, _site())
    if link:
        await post_link(AtlassianSettings().agent_host_url, ctx.identity.conversation_id, link)
    return ToolResult.ok(f"Created page {created.get('id')}: {link.url if link else title}")


@mcp.tool
async def confluence_update_page(
    page: str,
    edits: list[Edit] | None = None,
    body: str | None = None,
    title: str | None = None,
    message: str | None = None,
    format: Format = "markdown",
    ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Change a Confluence page (id or URL): exact-text `edits`, or a full `body` rewrite.

    Each edit's `old` must match exactly once in the current page, as Markdown or as
    storage XHTML per `format`; if any doesn't, nothing is written. Markdown edits
    refuse a page with macros or layouts Markdown can't keep; use `format="storage"`
    there. Pass `title` alone to rename. A 409 means someone else saved first:
    re-read the page and retry.
    """
    if edits is not None and body is not None:
        return ToolResult.error("Pass `edits` or `body`, not both.")
    pid = page_id(page)
    if pid is None:
        return _bad_page(page)
    current = await _get(ctx, pid)
    if not current.is_success:
        return _failed(current)
    data = current.json()
    storage = ((data.get("body") or {}).get("storage") or {}).get("value", "")
    if body is not None:
        new = _to_storage(body, format)
    elif edits:
        pairs = [(e.old, e.new) for e in edits]
        try:
            if format == "storage":
                new = apply_edits(storage, pairs)
            elif lost := lossy_elements(storage):
                return ToolResult.error(
                    f"This page has {', '.join(lost)}, which Markdown can't keep, so a Markdown edit would "
                    "drop them. Nothing was written. Edit it with format=\"storage\" (read it the same way)."
                )
            else:
                new = markdown_to_storage(apply_edits(storage_to_markdown(storage), pairs))
        except EditError as e:
            return ToolResult.error(str(e))
    elif title:
        new = storage
    else:
        return ToolResult.error("Nothing to change: pass `edits`, `body` or `title`.")
    version: dict = {"number": int((data.get("version") or {}).get("number", 0)) + 1}
    if message:
        version["message"] = message
    response = await ctx.upstream.request("PUT", f"{V2}/pages/{pid}", json={
        "id": pid, "status": "current", "title": title or data.get("title", ""),
        "body": {"representation": "storage", "value": new}, "version": version,
    })
    if response.status_code == 409:
        return _failed(response, "\nSomeone saved the page first. Re-read it and apply your change again.")
    if not response.is_success:
        return _failed(response)
    url = page_url(response.json(), _site())
    return ToolResult.ok(f"Updated page {pid} to version {version['number']}" + (f": {url}" if url else "."))


@mcp.tool
async def confluence_comment(
    body: str, page: str | None = None, format: Format = "markdown", ctx: ToolContext = ToolContextDep,
) -> ToolResult:
    """Add a footer comment to a Confluence page (id or URL); without `page`, the page linked to this conversation."""
    pid = page_id(page) if page else await _linked_page(ctx)
    if pid is None:
        return _bad_page(page) if page else ToolResult.error(
            "This conversation has no Confluence page linked. Pass `page` (id or URL)."
        )
    response = await ctx.upstream.request("POST", f"{V2}/footer-comments", json={
        "pageId": pid, "body": {"representation": "storage", "value": _to_storage(body, format)},
    })
    if not response.is_success:
        return _failed(response)
    return ToolResult.ok(f"Commented on page {pid}.")


def confluence_mcp_server() -> FastMCP:
    return mcp
