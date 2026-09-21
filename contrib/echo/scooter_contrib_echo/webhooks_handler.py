"""Echo webhooks handler — the webhooks half of the reference contrib.

Registered into the webhooks service via the ``scooter_webhooks.handlers``
entry point (see pyproject.toml). It build-depends on ``scooter_webhooks_lib`` —
the webhooks extension surface — and on nothing from the webhooks APP, so a typo
here fails this package's own build rather than surfacing as a missing handler
at service startup. See PR #567.

Mounts ``POST /webhooks/echo`` — a signature-free endpoint that echoes its
payload back. It does NOT spawn a conversation, so it is inert if ever mounted
outside a test image. This is the minimal shape a real handler follows.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from scooter_webhooks_lib.registry import WebhookHandler, register_webhook

HANDLER_NAME = "echo"

router = APIRouter()


class EchoEvent(BaseModel):
    message: str = ""


@router.post("/webhooks/echo")
async def echo_webhook(event: EchoEvent) -> dict:
    return {"handler": HANDLER_NAME, "echo": event.message}


@register_webhook
def echo_contrib() -> WebhookHandler:
    """Build the echo handler.

    Registered ``enabled`` like every built-in handler (webhooks handlers
    self-gate in-route rather than at mount time). A real handler would guard its
    work behind its own config; this example is inert (echo only).
    """
    return WebhookHandler(name=HANDLER_NAME, router=router)
