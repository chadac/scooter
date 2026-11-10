"""What a forge's `*_attachment` tool returns: an image the agent sees, text inline, or how to download a binary."""

from __future__ import annotations

import base64
from collections.abc import Awaitable, Callable

import httpx
from mcp.types import ImageContent, TextContent

from scooter_lib.attachments import MAX_IMAGE_BYTES, Fetched, FetchError, as_text, fenced, sniff_image

from .mcp import ToolResult

Download = Callable[[httpx.AsyncClient], Awaitable[tuple[str, Fetched]]]


async def attachment_tool(download: Download) -> ToolResult:
    """Run a forge's download and turn the outcome, or its failure, into the tool's result."""
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            name, fetched = await download(client)
        except FetchError as exc:
            return ToolResult.error(str(exc))
        except httpx.HTTPError as exc:
            return ToolResult.error(f"The download failed: {exc}")
    return attachment_result(name, fetched)


def attachment_result(name: str, fetched: Fetched) -> ToolResult:
    """`fetched` as tool content, by what it actually is rather than what the forge declared."""
    size = len(fetched.data)
    mime = sniff_image(fetched.data)
    if mime is not None and size <= MAX_IMAGE_BYTES:
        return ToolResult(content=[
            TextContent(type="text", text=f"{name} ({mime}, {size} bytes):"),
            ImageContent(type="image", data=base64.b64encode(fetched.data).decode(), mimeType=mime),
        ])
    text = as_text(name, fetched.data, fetched.content_type)
    if text is not None:
        return ToolResult.ok(fenced(name, text))
    kind = fetched.content_type.split(";")[0].strip() or "unknown type"
    note = f"{name} is a binary file ({kind}, {size} bytes), so it isn't shown here."
    if fetched.url:
        # A signed or forge-proxied URL, valid only for minutes.
        url = fetched.url.replace("'", "%27")
        note += f" Download it within a few minutes:\n\ncurl -fsSL -o '/workspace/uploads/{_safe(name)}' '{url}'"
    return ToolResult.ok(note)


def _safe(name: str) -> str:
    """A filename that can't leave the uploads directory or break the quoting."""
    cleaned = "".join(c for c in name.rsplit("/", 1)[-1] if c not in "'\\\x00").lstrip(".")
    return cleaned or "attachment"
