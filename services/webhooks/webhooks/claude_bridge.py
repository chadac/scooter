"""Claude bridge — the UNAUTHED front door for bring-your-own-Claude remote agents.

The user's container dials wss://<webhooks-host>/claude-bridge/connect with an owner-bound join
token. Webhooks has NO user-facing auth (providers authenticate by signature), so the container
doesn't get caught by the ALB/user-auth that fronts the agent-host UI. We VERIFY the join token
(HS256, the same REMOTE_AGENT_JOIN_SECRET the agent-host signs with), then reverse-proxy the raw WS
frames to the agent-host's INTERNAL /remote-agent/connect (which re-verifies + registers). The UI
still mints the token from its authed agent-host path. See todo/docs/BYO_CLAUDE_REMOTE_AGENT.md.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time

import websockets
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .config import settings

logger = logging.getLogger(__name__)
router = APIRouter()

_AUDIENCE = "remote-agent"


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_join_token(token: str, secret: str, now: int | None = None) -> dict | None:
    """Verify an HS256 join JWT (matches services/agent-host/src/auth/remoteAgentToken.ts).
    Returns the claims on success, else None."""
    now = now if now is not None else int(time.time())
    parts = token.split(".")
    if len(parts) != 3:
        return None
    header_b64, claims_b64, sig_b64 = parts
    expected = hmac.new(secret.encode(), f"{header_b64}.{claims_b64}".encode(), hashlib.sha256).digest()
    try:
        sig = _b64url_decode(sig_b64)
    except Exception:
        return None
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        claims = json.loads(_b64url_decode(claims_b64))
    except Exception:
        return None
    if claims.get("aud") != _AUDIENCE:
        return None
    if not isinstance(claims.get("owner"), str) or not claims["owner"]:
        return None
    exp = claims.get("exp")
    if not isinstance(exp, (int, float)) or exp <= now:
        return None
    return claims


def _agent_host_ws_url() -> str:
    """The agent-host's INTERNAL /remote-agent/connect WS URL (http→ws, https→wss)."""
    base = settings.agent_host_url.rstrip("/")
    if base.startswith("https://"):
        return "wss://" + base[len("https://"):] + "/remote-agent/connect"
    if base.startswith("http://"):
        return "ws://" + base[len("http://"):] + "/remote-agent/connect"
    return "ws://" + base + "/remote-agent/connect"


@router.websocket("/claude-bridge/connect")
async def claude_bridge_connect(ws: WebSocket):
    """Accept the container's WS, verify its join token, then pipe frames to the agent-host."""
    secret = settings.remote_agent_join_secret
    if not secret:
        # BYO not enabled on this deployment.
        await ws.close(code=4404, reason="remote agents not enabled")
        return
    await ws.accept()

    # The FIRST message must be the hello {protocolVersion, joinToken} — verify it before opening
    # the upstream, so a bad token never reaches the internal endpoint (defense in depth; the
    # agent-host re-verifies too).
    try:
        first = await asyncio.wait_for(ws.receive_text(), timeout=10)
        hello = json.loads(first)
    except Exception:
        await ws.close(code=4002, reason="bad hello")
        return
    claims = verify_join_token(hello.get("joinToken", ""), secret)
    if claims is None:
        await ws.close(code=4004, reason="auth failed")
        return

    upstream_url = _agent_host_ws_url()
    logger.info("claude-bridge: owner %s verified — proxying to %s", claims.get("owner"), upstream_url)
    try:
        async with websockets.connect(upstream_url, max_size=None) as upstream:
            # Replay the hello upstream (the agent-host expects it first + re-verifies).
            await upstream.send(first)
            await _pipe(ws, upstream)
    except Exception as e:  # upstream unreachable / closed
        logger.warning("claude-bridge: upstream error: %s", e)
        try:
            await ws.close(code=1011, reason="upstream unavailable")
        except Exception:
            pass


async def _pipe(client: WebSocket, upstream) -> None:
    """Bidirectionally pipe text frames between the container (client) and the agent-host
    (upstream) until either side closes."""

    async def client_to_upstream():
        try:
            while True:
                msg = await client.receive_text()
                await upstream.send(msg)
        except (WebSocketDisconnect, Exception):
            pass

    async def upstream_to_client():
        try:
            async for msg in upstream:
                await client.send_text(msg if isinstance(msg, str) else msg.decode())
        except Exception:
            pass

    done, pending = await asyncio.wait(
        [asyncio.create_task(client_to_upstream()), asyncio.create_task(upstream_to_client())],
        return_when=asyncio.FIRST_COMPLETED,
    )
    for t in pending:
        t.cancel()
