"""Webhooks service — receives events from external sources and spawns agent
conversations in the agent-host."""

from contextlib import asynccontextmanager

import uvicorn
from fastapi import Depends, FastAPI, Request
from pydantic import BaseModel

from scooter_webhooks_lib import store as db

from .config import db_settings, require_relay_key, settings
from scooter_lib.logging_config import configure_logging
from scooter_webhooks_lib.registry import discover_webhooks
from scooter_webhooks_lib import agent_host_client, policy
from scooter_webhooks_lib.agent_host_client import resolve_sandbox_to_conversation

# Imported for their REGISTRATION side effects: the per-provider email resolvers
# (#575) and resource shapes (#576) are registered at import, and nothing else
# imports either module.
from . import resource_shapes  # noqa: F401

# The lib is GIVEN its config, like store.init_db below. Bound at import, not in
# lifespan: handlers are discovered at import and may build URLs as they register.
agent_host_client.init(settings)
policy.init(settings)

configure_logging("webhooks", settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db(db_settings)
    # No message bus: the agent runs in the agent-host, reached directly via
    # POST /agui. Each provider posts a single "on it" message with the
    # conversation link; there is no live status to poll.
    yield
    await db.close_db()


app = FastAPI(title="agent-manager webhooks", version="0.1.0", lifespan=lifespan)

# Discover handler modules and mount each one's router — no hardcoded per-provider
# wiring here (mirrors the broker's create_app discovery). Adding a handler is a
# new module under handlers/ with an @register_webhook factory; app.py is untouched.
#
# The built-in package is passed in rather than hardcoded in the registry, so the
# registry carries no import of this app. See PR #567.
from . import handlers as _builtin_handlers  # noqa: E402

for _handler in discover_webhooks([_builtin_handlers]):
    app.include_router(_handler.router)


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

    The caller's (resource_type, resource_id) is taken as-is here and CANONICALISED by
    link_resource — normalising in the store, not per caller, is what keeps this path
    and the webhook handlers writing one shape. Why: issue #563.
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
        # and answered the (now-retired) /claude-bridge/connect with 404. Kept because ANY
        # uvicorn simply could not serve the upgrade. Naming the implementation removes the
        # auto-detection from the equation and turns a silent 404 into an import error if the
        # dependency is ever actually missing.
        ws="websockets",
    )
