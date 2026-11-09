"""Slack settings, owned by this contrib and shared by its broker and webhooks halves."""

from __future__ import annotations

import hmac

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from scooter_lib.settings import ScooterBaseSettings

_bearer_scheme = HTTPBearer(auto_error=False)


class SlackSettings(ScooterBaseSettings):
    # The bot token the broker injects into /slack/* and the webhooks half posts with.
    slack_bot_token: str = ""

    slack_enabled: bool = False
    slack_signing_secret: str = ""

    # Mirrors the agent-host ASSET_MAX_BYTES so a file it would reject is skipped up front.
    image_max_bytes: int = 5 * 1024 * 1024

    # Max bytes for any non-image inbound attachment.
    file_max_bytes: int = 10 * 1024 * 1024

    # Mirrors agent-host FILE_MAX_PER_MESSAGE; past it, it rejects everything.
    file_max_per_message: int = 4

    # Shared API key for the /slack/reply relay endpoint; empty disables the gate.
    relay_api_key: str = ""


settings = SlackSettings()


def require_relay_key(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer_scheme),
) -> None:
    """Gate the relay endpoint on the relay key with a constant-time compare."""
    key = settings.relay_api_key
    if not key:
        return
    if credentials is None or not hmac.compare_digest(credentials.credentials, key):
        raise HTTPException(status_code=401, detail="Invalid or missing relay API key")
