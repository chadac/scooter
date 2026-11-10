"""Jira attachments: find them in wiki markup, match them to the issue's files, and download one by id.

A ref is `jira:<attachment id>`. Comments name attachments by filename (`!shot.png|thumbnail!`,
`[^build.log]`), so the webhook resolves names against the issue's `attachment` field. The
download is `GET /rest/api/3/attachment/content/{id}`, which redirects to Atlassian's media
CDN; that hop goes through the shared SSRF guard without the bearer token.
"""

from __future__ import annotations

import re
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone

import httpx

from scooter_lib.attachments import AttachmentRef, Fetched, FetchError, dedupe, from_response, is_image_name

TOOL = "jira_attachment"

# `!name.png!` or `!name.png|thumbnail!` embeds a file; `[^name.pdf]` links one.
_EMBED = re.compile(r"!(?P<name>[^!|\n]+?)(?:\|[^!\n]*)?!")
_LINK = re.compile(r"\[\^(?P<name>[^\]\n]+)\]")
_REF = re.compile(r"^jira:(?P<id>\d+)$")
# Prose like "Hi! thanks!" matches _EMBED; filenames have extensions.
_FILENAME = re.compile(r"\.\w{1,8}$")
_EPOCH = datetime.min.replace(tzinfo=timezone.utc)

ApiGet = Callable[[str], Awaitable[httpx.Response]]


def referenced_names(text: str) -> list[str]:
    """The attachment filenames wiki markup embeds or links, in order; external image URLs are skipped."""
    found = [(m.start(), m["name"].strip()) for m in _EMBED.finditer(text or "")]
    found += [(m.start(), m["name"].strip()) for m in _LINK.finditer(text or "")]
    names = (name for _, name in sorted(found))
    return list(dict.fromkeys(n for n in names if _FILENAME.search(n) and "://" not in n))


def _when(stamp: str | None) -> datetime | None:
    try:
        return datetime.strptime(stamp or "", "%Y-%m-%dT%H:%M:%S.%f%z")
    except ValueError:
        return None


def _ref(attachment: dict) -> AttachmentRef:
    name = str(attachment.get("filename") or attachment.get("id"))
    return AttachmentRef(name=name, ref=f"jira:{attachment['id']}", image=is_image_name(name))


def match(names: list[str], attachments: list[dict], before: str | None = None) -> list[AttachmentRef]:
    """Refs for `names`; where several files share a name, the newest one created by `before`."""
    cutoff = _when(before)
    refs: list[AttachmentRef] = []
    for name in names:
        candidates = [a for a in attachments if a.get("filename") == name and a.get("id")]
        if cutoff is not None:
            earlier = [a for a in candidates if (_when(a.get("created")) or cutoff) <= cutoff]
            candidates = earlier or candidates
        if candidates:
            newest = max(candidates, key=lambda a: _when(a.get("created")) or _EPOCH)
            refs.append(_ref(newest))
    return dedupe(refs)


def all_refs(attachments: list[dict]) -> list[AttachmentRef]:
    """Every attachment on the issue, newest first, for a conversation the trigger label starts."""
    dated = [a for a in attachments if a.get("id")]
    dated.sort(key=lambda a: _when(a.get("created")) or _EPOCH, reverse=True)
    return dedupe(_ref(a) for a in dated)


def _id(ref: str) -> str:
    m = _REF.match(ref.strip())
    if m is None:
        raise FetchError(f"{ref!r} is not a Jira attachment ref; pass the `jira:…` ref from the message as written")
    return m["id"]


async def fetch(ref: str, api_get: ApiGet, client: httpx.AsyncClient, *, max_bytes: int) -> tuple[str, Fetched]:
    """Download `ref`: its metadata first, so an oversize file is refused unread, then its content."""
    attachment_id = _id(ref)
    meta = await api_get(f"rest/api/3/attachment/{attachment_id}")
    if meta.status_code == 404:
        raise FetchError(f"attachment {attachment_id}: not found, or the Jira credential can't read its issue")
    if meta.status_code != 200:
        raise FetchError(f"attachment {attachment_id}: Jira answered HTTP {meta.status_code}")
    info = meta.json()
    name = str(info.get("filename") or attachment_id)
    if int(info.get("size") or 0) > max_bytes:
        raise FetchError(f"{name} is over the {max_bytes // (1024 * 1024)} MB limit")
    response = await api_get(f"rest/api/3/attachment/content/{attachment_id}")
    return name, await from_response(client, response, max_bytes=max_bytes)
