"""Webhooks service — receives events from external sources and spawns agent
conversations in the agent-host."""

import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import Depends, FastAPI, Request
from pydantic import BaseModel

from . import store as db

from .config import db_settings, require_relay_key, settings
from .handlers.github import router as github_router
from .handlers.gitlab import router as gitlab_router
from .handlers.jira import router as jira_router
from .handlers.slack import router as slack_router
from .handlers.test import router as test_router
from .claude_bridge import router as claude_bridge_router
from .agent_host_client import resolve_sandbox_to_conversation

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db(db_settings)
    # No message bus: the agent runs in the agent-host, reached directly via
    # POST /agui. Each provider posts a single "on it" message with the
    # conversation link; there is no live status to poll.
    yield
    await db.close_db()


app = FastAPI(title="agent-manager webhooks", version="0.1.0", lifespan=lifespan)
app.include_router(github_router)
app.include_router(gitlab_router)
app.include_router(jira_router)
app.include_router(slack_router)
app.include_router(test_router)
# BYO-Claude: the unauthed WS front door (/claude-bridge/connect) → proxies to the agent-host.
app.include_router(claude_bridge_router)


@app.get("/health")
async def health():
    return {"status": "ok"}


class LinkResourceRequest(BaseModel):
    source: str
    resource_type: str
    resource_id: str


@app.post("/conversations/link", dependencies=[Depends(require_relay_key)])
async def link_conversation_resource(request: Request, req: LinkResourceRequest):
    """Link an external resource to the calling conversation.

    Agents call this to register cross-platform links (e.g. a GitLab MR
    created from a Jira conversation).
    """
    raw_id = request.headers.get("x-conversation-id", "")
    if not raw_id:
        return {"linked": False, "error": "No X-Conversation-ID header"}

    conv_id = await resolve_sandbox_to_conversation(raw_id)
    if not conv_id:
        return {"linked": False, "error": f"Could not resolve conversation ID from '{raw_id}'"}

    is_new = await db.link_resource(conv_id, req.source, req.resource_type, req.resource_id)
    return {"linked": is_new, "conversation_id": conv_id}


def main():
    uvicorn.run(
        "webhooks.app:app",
        host="0.0.0.0",
        port=8080,
        log_level="info",
        # ws="websockets" EXPLICITLY. uvicorn's default is "auto", which probes for a WS
        # implementation at startup — and under nix that probe failed even though `websockets`
        # is a declared dependency, so the server logged
        #   "No supported WebSocket library detected" / "Unsupported upgrade request"
        # and answered /claude-bridge/connect with 404. The route was registered the whole time;
        # uvicorn simply could not serve the upgrade. Naming the implementation removes the
        # auto-detection from the equation and turns a silent 404 into an import error if the
        # dependency is ever actually missing.
        ws="websockets",
    )
