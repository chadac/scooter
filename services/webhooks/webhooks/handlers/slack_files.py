"""Download files attached to a Slack message so they reach the agent.

A Slack message event carries a `files` array; each file has a private
`url_private_download` needing the bot token. We split the attachments three ways:

1. **Images** (image/png,jpeg,gif,webp) -> fetched base64 for the /agui multimodal
   image content parts (the original `download_images` behavior, unchanged).
2. **Text-representable files** (text/* mimetypes, known text extensions, Slack
   snippets) -> fetched and INLINED into the agent's message as a fenced block with
   a `[Attached file: <name>]` header (with a language hint when the extension is
   known). Becomes part of the message TEXT — no new content-part type.
3. **Binary files** (everything else — pdf, zip, docx, …) -> fetched bytes, forwarded
   as `{name, data(base64), mimeType}` file parts. The agent-host materializes each
   into the sandbox at /workspace/.slack/<name>.

Best-effort throughout: a file that can't be downloaded / is over the size cap /
lacks a URL is skipped (logged), never raised — a bad attachment must not drop the
whole message.
"""

from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass, field

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

# Images the agent can see (mirrors the agent-host AssetStore allow-list).
_ALLOWED_MIME = {"image/png", "image/jpeg", "image/gif", "image/webp"}

# Where the agent-host materializes binary attachments in the sandbox.
SLACK_FILES_DIR = "/workspace/.slack"

# Extensions we treat as text (inline into the message). Maps to a fenced-code
# language hint (empty string -> plain fence).
_TEXT_EXT_LANG = {
    ".txt": "",
    ".md": "markdown",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".log": "",
    ".csv": "",
    ".py": "python",
    ".js": "javascript",
    ".ts": "typescript",
    ".sh": "bash",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".cpp": "cpp",
    ".h": "c",
    ".nix": "nix",
    ".toml": "toml",
    ".html": "html",
    ".css": "css",
    ".xml": "xml",
}


@dataclass
class DownloadedFiles:
    """The split result of a Slack message's `files` array.

    - `images`: [{data(base64), mimeType}] for the multimodal image parts (as before).
    - `inline_text`: a string block of every text-representable file, fenced with a
      `[Attached file: <name>]` header — the caller weaves this into the message text.
      Empty when there are no text files.
    - `file_parts`: [{name, data(base64), mimeType}] for binary attachments the
      agent-host writes to /workspace/.slack/<name>.
    """

    images: list[dict] = field(default_factory=list)
    inline_text: str = ""
    file_parts: list[dict] = field(default_factory=list)


def _image_max_bytes() -> int:
    return getattr(settings, "image_max_bytes", 5 * 1024 * 1024)


def _file_max_bytes() -> int:
    # `file_max_bytes` generalizes the old `image_max_bytes` cap to non-image files;
    # fall back to image_max_bytes (then 5 MiB) so existing config keeps working.
    return getattr(settings, "file_max_bytes", _image_max_bytes())


def _cap_for(f: dict) -> int:
    """Size cap for a file: the image cap for images, the general file cap otherwise."""
    mimetype = (f.get("mimetype") or "").lower()
    return _image_max_bytes() if mimetype in _ALLOWED_MIME else _file_max_bytes()


def _is_text_file(f: dict) -> bool:
    """A Slack file is text-representable when its mimetype is text/*, its extension
    is a known text extension, or Slack flagged it as a snippet (filetype in the
    snippet family / an editable Slack snippet)."""
    mimetype = (f.get("mimetype") or "").lower()
    if mimetype.startswith("text/"):
        return True
    name = f.get("name") or ""
    _, ext = os.path.splitext(name.lower())
    if ext in _TEXT_EXT_LANG:
        return True
    # Slack snippets: `mode == "snippet"`, or an editable/plain-text file.
    if f.get("mode") == "snippet":
        return True
    filetype = (f.get("filetype") or "").lower()
    if filetype in ("text", "snippet", "post"):
        return True
    return False


def _lang_hint(name: str, filetype: str = "") -> str:
    """A fenced-code language hint from the filename extension (fallback: the Slack
    `filetype`, else plain)."""
    _, ext = os.path.splitext((name or "").lower())
    lang = _TEXT_EXT_LANG.get(ext)
    if lang is not None:
        return lang
    # Slack sets `filetype` (e.g. "python", "javascript") on snippets.
    return (filetype or "").lower()


def _inline_block(name: str, content: str, lang: str) -> str:
    """Build the fenced `[Attached file: <name>]` block for a text file."""
    fence_lang = lang or ""
    # Guard against content that itself contains a ``` fence by using a longer fence.
    fence = "```"
    while fence in content:
        fence += "`"
    return f"[Attached file: {name}]\n{fence}{fence_lang}\n{content}\n{fence}"


async def download_files(files: list[dict] | None) -> DownloadedFiles:
    """Split + fetch a Slack message's `files` into images, inlined text, and binary
    file parts. Best-effort: skips non-downloadable / oversize files (logged).

    Returns an empty `DownloadedFiles` when there are no files / no bot token."""
    result = DownloadedFiles()
    if not files:
        return result
    token = settings.slack_bot_token
    if not token:
        logger.warning("Slack message has files but SLACK_BOT_TOKEN is unset — cannot download files")
        return result

    text_blocks: list[str] = []

    async with httpx.AsyncClient(timeout=30) as client:
        for f in files:
            name = f.get("name") or "file"
            mimetype = (f.get("mimetype") or "").lower()
            max_bytes = _cap_for(f)

            # Skip early when Slack's declared size is over the cap.
            size = f.get("size")
            if isinstance(size, int) and size > max_bytes:
                logger.info("Slack file %s is %d bytes (> cap) — skipping", name, size)
                continue

            url = f.get("url_private_download") or f.get("url_private")
            if not url:
                continue

            try:
                resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
                resp.raise_for_status()
                data = resp.content
            except httpx.HTTPError as e:
                logger.warning("Slack file download failed for %s: %s", name, e)
                continue

            if len(data) > max_bytes:
                logger.info("Slack file %s is %d bytes (> cap) — skipping", name, len(data))
                continue

            if mimetype in _ALLOWED_MIME:
                # (1) image -> multimodal content part (unchanged behavior).
                result.images.append(
                    {"data": base64.b64encode(data).decode("ascii"), "mimeType": mimetype}
                )
            elif _is_text_file(f):
                # (2) text-representable -> inline into the message text.
                try:
                    text = data.decode("utf-8")
                except UnicodeDecodeError:
                    # Declared/looked textual but isn't valid UTF-8 — fall back to a
                    # binary file part rather than mangling it.
                    logger.info("Slack file %s isn't valid UTF-8 — forwarding as a binary attachment", name)
                    result.file_parts.append(
                        {
                            "name": name,
                            "data": base64.b64encode(data).decode("ascii"),
                            "mimeType": mimetype or "application/octet-stream",
                        }
                    )
                    continue
                text_blocks.append(_inline_block(name, text, _lang_hint(name, f.get("filetype") or "")))
            else:
                # (3) binary -> file part the agent-host writes to /workspace/.slack.
                result.file_parts.append(
                    {
                        "name": name,
                        "data": base64.b64encode(data).decode("ascii"),
                        "mimeType": mimetype or "application/octet-stream",
                    }
                )

    result.inline_text = "\n\n".join(text_blocks)
    return result


async def download_images(files: list[dict] | None) -> list[dict]:
    """Back-compat shim: return [{data: base64, mimeType}] for the image files only.

    Delegates to `download_files` and keeps the original image-only contract."""
    return (await download_files(files)).images
