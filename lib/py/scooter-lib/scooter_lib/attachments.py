"""Forge attachments: the refs a webhook forwards, and the guarded download that resolves them.

A webhook lists each attachment as a ref the agent passes to the source's broker tool
(`github_attachment`, `gitlab_attachment`, `jira_attachment`), so nothing is stored and
signed URLs are resolved fresh on each call. Images in a conversation's first message are
also downloaded up front so the agent sees them on its first turn. Every download goes
through `guarded_get` or `from_response`, so neither a referenced URL nor a redirect can
reach an internal address.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import socket
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import urljoin, urlsplit

import httpx

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_FILE_BYTES = 10 * 1024 * 1024
# Cut longer text so one log can't fill the context.
MAX_INLINE_TEXT_BYTES = 256 * 1024
# Images inlined into a conversation's first message.
MAX_FIRST_MESSAGE_IMAGES = 8
MAX_REDIRECTS = 5

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}
TEXT_EXTENSIONS = {
    ".txt", ".log", ".md", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml", ".xml",
    ".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".py", ".go", ".rs", ".java", ".kt",
    ".c", ".h", ".cpp", ".hpp", ".rb", ".sh", ".sql", ".nix", ".diff", ".patch", ".ini",
    ".cfg", ".conf", ".env",
}


@dataclass(frozen=True)
class AttachmentRef:
    """One attachment a message references."""

    name: str
    ref: str  # opaque; the source's broker tool resolves it
    image: bool


@dataclass(frozen=True)
class Fetched:
    data: bytes
    content_type: str
    url: str = ""  # the final URL, after redirects


class FetchError(Exception):
    """A download that was refused or failed; the message is safe to show the agent."""


def is_image_name(name: str) -> bool:
    return PurePosixPath(name.lower()).suffix in IMAGE_EXTENSIONS


def dedupe(refs: Iterable[AttachmentRef]) -> list[AttachmentRef]:
    """Refs in document order, each ref once."""
    return list({r.ref: r for r in refs}.values())


def refs_block(tool: str, refs: list[AttachmentRef]) -> str:
    """The text appended to a forwarded message, listing what the agent can fetch."""
    if not refs:
        return ""
    lines = [f"[Attachments: fetch one with `{tool}(ref)` when you need it]"]
    for r in refs:
        kind = " (image)" if r.image else ""
        lines.append(f"- {r.name}{kind}, ref: `{r.ref}`")
    return "\n\n" + "\n".join(lines)


def sniff_image(data: bytes) -> str | None:
    """The image MIME type from magic bytes; forges often serve uploads as octet-stream."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def as_text(name: str, data: bytes, content_type: str) -> str | None:
    """The file as text, if it is text; None for binary."""
    mime = content_type.split(";")[0].strip().lower()
    textual = (
        mime.startswith("text/")
        or mime in ("application/json", "application/xml", "application/x-yaml")
        or PurePosixPath(name.lower()).suffix in TEXT_EXTENSIONS
    )
    if not textual or b"\x00" in data[:8192]:
        return None
    return data.decode("utf-8", errors="replace")


def fenced(name: str, text: str) -> str:
    """`text` as a fenced block whose fence can't be closed by the content."""
    fence = "```"
    while fence in text:
        fence += "`"
    cut = ""
    if len(text.encode()) > MAX_INLINE_TEXT_BYTES:
        text = text.encode()[:MAX_INLINE_TEXT_BYTES].decode(errors="ignore")
        cut = f"\n[truncated at {MAX_INLINE_TEXT_BYTES // 1024} KB]"
    return f"{name}:\n{fence}\n{text}\n{fence}{cut}"


Resolver = Callable[[str], Awaitable[list[str]]]


async def _resolve(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


async def _check_public(host: str, resolve: Resolver) -> None:
    """Refuse a host that resolves to any non-public address."""
    try:
        addresses = await resolve(host)
    except OSError as exc:
        raise FetchError(f"cannot resolve {host}") from exc
    if not addresses:
        raise FetchError(f"cannot resolve {host}")
    for address in addresses:
        if not ipaddress.ip_address(address.split("%")[0]).is_global:
            raise FetchError(f"refusing {host}: it resolves to a non-public address")


def _never(_host: str) -> bool:
    return False


def _cap(max_bytes: int) -> FetchError:
    return FetchError(f"file is over the {max_bytes // (1024 * 1024)} MB limit")


def _check_declared(response: httpx.Response, max_bytes: int) -> None:
    declared = response.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > max_bytes:
        raise _cap(max_bytes)


async def guarded_get(
    client: httpx.AsyncClient,
    url: str,
    *,
    allowed: Callable[[str], bool],
    max_bytes: int,
    headers: dict[str, str] | None = None,
    resolve: Resolver = _resolve,
) -> Fetched:
    """GET `url` on an allowed host, following redirects one hop at a time.

    `headers` (the forge credential) go only to the first host. A hop off the allowed
    hosts must be https and resolve to public addresses only, and the body is capped
    while it streams, so neither a comment nor a redirect can reach inside the cluster.
    """
    first_host = urlsplit(url).hostname or ""
    if not allowed(first_host):
        raise FetchError(f"{first_host or url} is not one of this source's hosts")
    return await _walk(client, url, allowed, max_bytes, headers, first_host, resolve)


async def _walk(
    client: httpx.AsyncClient,
    url: str,
    allowed: Callable[[str], bool],
    max_bytes: int,
    headers: dict[str, str] | None,
    first_host: str,
    resolve: Resolver,
) -> Fetched:
    for _ in range(MAX_REDIRECTS + 1):
        parts = urlsplit(url)
        host = parts.hostname or ""
        if not allowed(host):
            if parts.scheme != "https":
                raise FetchError(f"refusing a non-https redirect to {host}")
            await _check_public(host, resolve)
        sent = headers if host == first_host else None
        async with client.stream("GET", url, headers=sent, follow_redirects=False) as response:
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    raise FetchError(f"redirect without a location from {host}")
                url = urljoin(url, location)
                continue
            if response.status_code != 200:
                raise FetchError(f"{host} answered HTTP {response.status_code}")
            _check_declared(response, max_bytes)
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body += chunk
                if len(body) > max_bytes:
                    raise _cap(max_bytes)
            return Fetched(bytes(body), response.headers.get("content-type", ""), url)
    raise FetchError(f"more than {MAX_REDIRECTS} redirects")


async def from_response(
    client: httpx.AsyncClient,
    response: httpx.Response,
    *,
    max_bytes: int,
    resolve: Resolver = _resolve,
) -> Fetched:
    """The download an authenticated API response leads to.

    The forge answers with the bytes or a redirect to blob storage. Every redirect hop
    is treated as untrusted: https, public addresses only, and no credential.
    """
    if response.is_redirect:
        location = response.headers.get("location")
        if not location:
            raise FetchError("redirect without a location")
        return await _walk(
            client, urljoin(str(response.request.url), location), _never, max_bytes, None, "", resolve,
        )
    if response.status_code != 200:
        raise FetchError(f"the forge answered HTTP {response.status_code}")
    _check_declared(response, max_bytes)
    if len(response.content) > max_bytes:
        raise _cap(max_bytes)
    return Fetched(response.content, response.headers.get("content-type", ""), str(response.request.url))


def image_part(fetched: Fetched) -> dict | None:
    """The agent-host image part for a download, or None if it isn't a supported image."""
    mime = sniff_image(fetched.data)
    if mime is None:
        return None
    return {"data": base64.b64encode(fetched.data).decode(), "mimeType": mime}


async def inline_images(
    refs: list[AttachmentRef],
    fetch: Callable[[AttachmentRef], Awaitable[Fetched]],
    limit: int = MAX_FIRST_MESSAGE_IMAGES,
) -> list[dict]:
    """The first `limit` image refs as image parts, fetched at once; a failed one is skipped, its ref still listed."""

    async def one(ref: AttachmentRef) -> dict | None:
        try:
            return image_part(await fetch(ref))
        except (FetchError, httpx.HTTPError):
            return None

    parts = await asyncio.gather(*(one(r) for r in [r for r in refs if r.image][:limit]))
    return [p for p in parts if p is not None]
