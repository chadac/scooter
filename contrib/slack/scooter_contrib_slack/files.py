"""Download files attached to a Slack message so they reach the agent.

Attachments are split three ways: images become multimodal image parts, text files
are inlined into the message as fenced blocks, and binary files become file parts
the agent-host writes into the sandbox. Best-effort throughout: a file that cannot
be downloaded, is over a cap or lacks a URL is skipped, and listed in `skipped` so
the message can say so. Files Slack sends without a URL are looked up via files.info.
"""

from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass, field

import httpx

from .config import settings
from scooter_lib.logging_config import format_error

logger = logging.getLogger(__name__)
_C = {"component": "handlers.slack_files"}

_SLACK_API = "https://slack.com/api"

# Mirrors the agent-host AssetStore allow-list.
_ALLOWED_MIME = {"image/png", "image/jpeg", "image/gif", "image/webp"}

# Extensions treated as text, mapped to a fenced-code language hint (empty for a plain fence).
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


@dataclass(frozen=True)
class Skipped:
    """A file left out of the message, and why."""

    name: str
    mimetype: str
    size: int | None
    reason: str
    # The download URL, else the permalink.
    url: str

    def line(self) -> str:
        details = ", ".join(x for x in (self.mimetype, _human_size(self.size) if self.size is not None else "") if x)
        head = f"{self.name} ({details})" if details else self.name
        tail = f" URL: {self.url}" if self.url else ""
        return f"[Attachment not forwarded: {head}: {self.reason}.{tail}]"


@dataclass
class DownloadedFiles:
    """The split result of a Slack message's `files` array: image parts, the inlined text block, and binary file parts."""

    images: list[dict] = field(default_factory=list)
    inline_text: str = ""
    file_parts: list[dict] = field(default_factory=list)
    skipped: list[Skipped] = field(default_factory=list)

    @property
    def notice(self) -> str:
        """One line per file that was not forwarded, so the agent knows it exists."""
        return "\n".join(s.line() for s in self.skipped)


def _image_max_bytes() -> int:
    return getattr(settings, "image_max_bytes", 5 * 1024 * 1024)


def _file_max_bytes() -> int:
    return getattr(settings, "file_max_bytes", _image_max_bytes())


def _max_file_parts() -> int:
    return getattr(settings, "file_max_per_message", 4)


def _cap_for(f: dict) -> int:
    """Size cap for a file: the image cap for images, the general file cap otherwise."""
    mimetype = (f.get("mimetype") or "").lower()
    return _image_max_bytes() if mimetype in _ALLOWED_MIME else _file_max_bytes()


def _is_text_file(f: dict) -> bool:
    """True when the mimetype is text/*, the extension is a known text extension, or Slack flagged it as a snippet."""
    mimetype = (f.get("mimetype") or "").lower()
    if mimetype.startswith("text/"):
        return True
    name = f.get("name") or ""
    _, ext = os.path.splitext(name.lower())
    if ext in _TEXT_EXT_LANG:
        return True
    if f.get("mode") == "snippet":
        return True
    filetype = (f.get("filetype") or "").lower()
    if filetype in ("text", "snippet", "post"):
        return True
    return False


def _lang_hint(name: str, filetype: str = "") -> str:
    """A fenced-code language hint from the extension, falling back to Slack's `filetype`."""
    _, ext = os.path.splitext((name or "").lower())
    lang = _TEXT_EXT_LANG.get(ext)
    if lang is not None:
        return lang
    return (filetype or "").lower()


def _inline_block(name: str, content: str, lang: str) -> str:
    """Build the fenced `[Attached file: <name>]` block for a text file."""
    fence_lang = lang or ""
    # Content that itself contains a fence gets a longer one.
    fence = "```"
    while fence in content:
        fence += "`"
    return f"[Attached file: {name}]\n{fence}{fence_lang}\n{content}\n{fence}"


def _human_size(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    if n >= 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n} B"


def _skip(result: DownloadedFiles, f: dict, reason: str) -> None:
    size = f.get("size")
    result.skipped.append(
        Skipped(
            name=f.get("name") or "file",
            mimetype=(f.get("mimetype") or "").lower(),
            size=size if isinstance(size, int) else None,
            reason=reason,
            url=f.get("url_private_download") or f.get("url_private") or f.get("permalink") or "",
        )
    )


async def _file_info(client: httpx.AsyncClient, token: str, f: dict) -> dict:
    """The file's full record from files.info, for shared-channel files Slack sends without a URL; `f` on failure."""
    file_id = f.get("id")
    if not file_id:
        return f
    try:
        resp = await client.get(
            f"{_SLACK_API}/files.info",
            headers={"Authorization": f"Bearer {token}"},
            params={"file": file_id},
        )
        data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        logger.warning("files.info failed", extra={**_C, "file_id": file_id, "error": format_error(e)})
        return f
    if not data.get("ok") or not isinstance(data.get("file"), dict):
        logger.info("files.info not ok", extra={**_C, "file_id": file_id, "slack_error": data.get("error")})
        return f
    return {**f, **data["file"]}


def _needs_info(f: dict) -> bool:
    return f.get("file_access") == "check_file_info" or not (f.get("url_private_download") or f.get("url_private"))


async def download_files(files: list[dict] | None) -> DownloadedFiles:
    """Fetch and split a Slack message's `files`, recording what cannot be forwarded in `skipped`."""
    result = DownloadedFiles()
    if not files:
        return result
    token = settings.slack_bot_token
    if not token:
        logger.warning(
            "message has files but slack bot token is unset, cannot download",
            extra={**_C, "file_count": len(files)},
        )
        for f in files:
            _skip(result, f, "the Slack bot token is not configured")
        return result

    text_blocks: list[str] = []
    max_parts = _max_file_parts()

    async with httpx.AsyncClient(timeout=30) as client:
        for f in files:
            if _needs_info(f):
                f = await _file_info(client, token, f)
            name = f.get("name") or "file"
            mimetype = (f.get("mimetype") or "").lower()
            max_bytes = _cap_for(f)
            over_cap = f"over the {_human_size(max_bytes)} limit"
            # Non-UTF-8 text also becomes a part, re-checked below.
            becomes_part = mimetype not in _ALLOWED_MIME and not _is_text_file(f)
            too_many = f"more than {max_parts} files in one message"

            size = f.get("size")
            if isinstance(size, int) and size > max_bytes:
                logger.info(
                    "file over size cap, skipping",
                    extra={
                        **_C,
                        "file_name": name,
                        "size_bytes": size,
                        "max_bytes": max_bytes,
                        "size_from": "declared",
                    },
                )
                _skip(result, f, over_cap)
                continue
            if becomes_part and len(result.file_parts) >= max_parts:
                _skip(result, f, too_many)
                continue

            url = f.get("url_private_download") or f.get("url_private")
            if not url:
                _skip(result, f, "Slack gave no download link")
                continue

            try:
                resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
                resp.raise_for_status()
                data = resp.content
            except httpx.HTTPError as e:
                logger.warning(
                    "file download failed",
                    extra={**_C, "file_name": name, "error": format_error(e)},
                )
                _skip(result, f, "the download failed")
                continue

            if len(data) > max_bytes:
                logger.info(
                    "file over size cap, skipping",
                    extra={
                        **_C,
                        "file_name": name,
                        "size_bytes": len(data),
                        "max_bytes": max_bytes,
                        "size_from": "downloaded",
                    },
                )
                _skip(result, {**f, "size": len(data)}, over_cap)
                continue

            if mimetype in _ALLOWED_MIME:
                result.images.append(
                    {"data": base64.b64encode(data).decode("ascii"), "mimeType": mimetype}
                )
                continue
            if not becomes_part:
                try:
                    text = data.decode("utf-8")
                except UnicodeDecodeError:
                    # Not valid UTF-8 after all, so forward it as a binary part rather than mangle it.
                    logger.info(
                        "file is not valid utf-8, forwarding as a binary attachment",
                        extra={**_C, "file_name": name, "mime_type": mimetype},
                    )
                else:
                    text_blocks.append(_inline_block(name, text, _lang_hint(name, f.get("filetype") or "")))
                    continue
            if len(result.file_parts) >= max_parts:
                _skip(result, f, too_many)
                continue
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
    """The image parts only."""
    return (await download_files(files)).images
