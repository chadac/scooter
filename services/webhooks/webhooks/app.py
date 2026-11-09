"""Webhooks service: receives events from external sources and spawns agent conversations in the agent-host."""

from contextlib import asynccontextmanager

import uvicorn
from fastapi import Depends, FastAPI, Request
from pydantic import BaseModel

from scooter_webhooks_lib import store as db

from .config import db_settings, require_relay_key, settings
from scooter_lib.logging_config import configure_logging
from scooter_webhooks_lib.registry import discover_webhooks
from scooter_webhooks_lib import agent_host_client, policy, tasks
from scooter_webhooks_lib.agent_host_client import resolve_sandbox_to_conversation

# Bound at import rather than in the lifespan, since handlers are discovered at import.
agent_host_client.init(settings)
policy.init(settings)

configure_logging("webhooks", settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db(db_settings)
    yield
    # Let in-flight deliveries finish before the pool closes.
    await tasks.drain(timeout=10)
    await db.close_db()


app = FastAPI(title="agent-manager webhooks", version="0.1.0", lifespan=lifespan)

# Discover handler modules and mount each one's router; the built-in package is passed
# in so the registry carries no import of this app.
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
    """Link an external resource to the calling conversation, leaving canonicalisation of (resource_type, resource_id) to link_resource."""
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
        # Named explicitly so a missing WS dependency is an import error rather than a silent 404.
        ws="websockets",
    )
