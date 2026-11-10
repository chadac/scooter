"""GitLab uploads: find them in Markdown, name them as refs, and download one through the uploads API.

A ref is `gl:<project>:<secret>/<filename>`, where `<project>` is the numeric id or the
URL-encoded path. It maps to `GET /api/v4/projects/:id/uploads/:secret/:filename`, so
the forge credential decides what a ref can read, the same as it does in the sandbox.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from urllib.parse import quote, unquote

import httpx

from scooter_lib.attachments import AttachmentRef, Fetched, FetchError, dedupe, from_response, is_image_name

TOOL = "gitlab_attachment"

_FILE = r"(?P<secret>[0-9a-f]{32})/(?P<file>[^\s)\"'<>?#/]+)"
# /-/project/<id>/uploads/… and /<namespace>/<project>/uploads/…, optionally absolute.
_BY_ID = re.compile(r"(?:https://(?P<host>[^/\s]+))?/-/project/(?P<id>\d+)/uploads/" + _FILE)
_BY_PATH = re.compile(r"https://(?P<host>[^/\s]+)/(?P<path>[\w.-]+(?:/[\w.-]+)+?)/uploads/" + _FILE)
# Project-relative; the lookbehind skips the absolute forms.
_RELATIVE = re.compile(r"(?<![\w/.-])/uploads/" + _FILE)

_REF = re.compile(r"^gl:(?P<project>\d+|[\w.%-]+):(?P<secret>[0-9a-f]{32})/(?P<file>[^/?#\s]+)$")

ApiGet = Callable[[str], Awaitable[httpx.Response]]


def _ref(project: str, secret: str, file: str) -> AttachmentRef:
    name = unquote(file)
    # Re-quoted so the ref is one space-free token.
    encoded = quote(name, safe="")
    return AttachmentRef(
        name=name,
        ref=f"gl:{project}:{secret}/{encoded}",
        image=is_image_name(name),
    )


def parse_refs(text: str, project_id: int | str, host: str) -> list[AttachmentRef]:
    """Every upload `text` links to, the relative ones resolved against `project_id`."""
    found: list[tuple[int, AttachmentRef]] = []
    for m in _BY_ID.finditer(text or ""):
        if m["host"] and m["host"].lower() != host.lower():
            continue
        found.append((m.start(), _ref(m["id"], m["secret"], m["file"])))
    for m in _BY_PATH.finditer(text or ""):
        if m["path"].startswith("-/") or m["host"].lower() != host.lower():
            continue
        found.append((m.start(), _ref(quote(m["path"], safe=""), m["secret"], m["file"])))
    for m in _RELATIVE.finditer(text or ""):
        found.append((m.start(), _ref(str(project_id), m["secret"], m["file"])))
    return dedupe(r for _, r in sorted(found, key=lambda pair: pair[0]))


def api_path(ref: str) -> tuple[str, str]:
    """The uploads API path for `ref`, and the file's name; FetchError if `ref` isn't a GitLab ref."""
    m = _REF.match(ref.strip())
    if m is None or ".." in m["file"]:
        raise FetchError(
            f"{ref!r} is not a GitLab attachment ref; pass the `gl:…` ref from the message as written"
        )
    return f"api/v4/projects/{m['project']}/uploads/{m['secret']}/{m['file']}", unquote(m["file"])


async def fetch(ref: str, api_get: ApiGet, client: httpx.AsyncClient, *, max_bytes: int) -> tuple[str, Fetched]:
    """Download `ref` with the forge credential `api_get` carries; any redirect goes through the SSRF guard."""
    path, name = api_path(ref)
    response = await api_get(path)
    if response.status_code == 404:
        raise FetchError(f"{name}: not found, or the forge credential can't read that project")
    return name, await from_response(client, response, max_bytes=max_bytes)
