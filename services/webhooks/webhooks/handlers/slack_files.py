"""Download image files attached to a Slack message so they reach the agent.

A Slack message event carries a `files` array; each image file has a private
`url_private_download` needing the bot token. We fetch the image bytes, enforce a
size cap + a MIME allow-list, and return them base64-encoded so the caller can post
them to the agent-host /agui as multimodal content parts. Best-effort: a file that
can't be downloaded / is too big / isn't an image is skipped (logged), never
raised — a bad attachment must not drop the whole message.
"""

from __future__ import annotations

import base64
import logging

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

# Images the agent can see (mirrors the agent-host AssetStore allow-list).
_ALLOWED_MIME = {"image/png", "image/jpeg", "image/gif", "image/webp"}


def _max_bytes() -> int:
    return getattr(settings, "image_max_bytes", 5 * 1024 * 1024)


async def download_images(files: list[dict] | None) -> list[dict]:
    """Return [{data: base64, mimeType}] for the image files on a Slack message.

    Skips non-images, oversize files, and anything that fails to download. Empty
    list when there are no images / no bot token."""
    if not files:
        return []
    token = settings.slack_bot_token
    if not token:
        logger.warning("Slack message has files but SLACK_BOT_TOKEN is unset — cannot download images")
        return []

    out: list[dict] = []
    async with httpx.AsyncClient(timeout=30) as client:
        for f in files:
            mimetype = (f.get("mimetype") or "").lower()
            if mimetype not in _ALLOWED_MIME:
                continue  # not an image we can forward
            # Slack sets size on the file object; skip early when it's over the cap.
            size = f.get("size")
            if isinstance(size, int) and size > _max_bytes():
                logger.info("Slack image %s is %d bytes (> cap) — skipping", f.get("name"), size)
                continue
            url = f.get("url_private_download") or f.get("url_private")
            if not url:
                continue
            try:
                resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
                resp.raise_for_status()
                data = resp.content
            except httpx.HTTPError as e:
                logger.warning("Slack image download failed for %s: %s", f.get("name"), e)
                continue
            if len(data) > _max_bytes():
                logger.info("Slack image %s is %d bytes (> cap) — skipping", f.get("name"), len(data))
                continue
            out.append({"data": base64.b64encode(data).decode("ascii"), "mimeType": mimetype})
    return out
