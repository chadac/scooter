"""Slack settings, owned by this contrib rather than the two apps.

Same env vars both services read before (SLACK_BOT_TOKEN, SLACK_ENABLED,
SLACK_SIGNING_SECRET, IMAGE_MAX_BYTES, FILE_MAX_BYTES, RELAY_API_KEY), so a
deployment needs no manifest change. Why: PR #588.
"""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from scooter_lib.settings import ScooterBaseSettings

_bearer_scheme = HTTPBearer(auto_error=False)


class SlackSettings(ScooterBaseSettings):
    # The bot token (xoxb-…): the broker proxies /slack/* with it injected, and the
    # webhooks half posts/reacts/downloads attachments with it.
    slack_bot_token: str = ""

    # Webhooks side.
    slack_enabled: bool = False
    slack_signing_secret: str = ""

    # Max bytes for an inbound image forwarded to the agent. Mirrors the agent-host
    # ASSET_MAX_BYTES so a file the agent-host would reject is skipped up front.
    image_max_bytes: int = 5 * 1024 * 1024

    # Max bytes for ANY inbound attachment (text-representable or binary), the same
    # cap generalized past images. Binaries land in the sandbox at /workspace/uploads.
    file_max_bytes: int = 10 * 1024 * 1024

    # Shared API key for the /slack/reply relay endpoint. Same env var, and the same
    # meaning, as the app's: empty disables the gate (dev/local only).
    relay_api_key: str = ""


settings = SlackSettings()


def require_relay_key(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer_scheme),
) -> None:
    """Gate the relay endpoint on the relay key (constant-time compare).

    Declared here, not imported: a contrib may not import the webhooks app. The
    scheduler already keeps its own copy for the same reason. Why: PR #588.
    """
    key = settings.relay_api_key
    if not key:
        return
    if credentials is None or not hmac.compare_digest(credentials.credentials, key):
        raise HTTPException(status_code=401, detail="Invalid or missing relay API key")
