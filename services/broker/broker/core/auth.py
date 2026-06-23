"""Caller authentication — validate the pod's projected SA token via K8s
TokenReview and extract the Identity.

Unchanged model from openhands-nix: the pod presents a projected ServiceAccount
token (audience agent-broker); we validate it and parse the SA username
`system:serviceaccount:{ns}:sandbox-{conversationId}`.

Design stage: interface only.
"""

from __future__ import annotations

import re

from fastapi import Request

from .types import Identity

# SA username pattern: system:serviceaccount:{ns}:sandbox-{conversationId}
_SA_PATTERN = re.compile(r"^system:serviceaccount:([^:]+):sandbox-(.+)$")


async def authenticate(request: Request) -> Identity:
    """FastAPI dependency: validate the Bearer SA token and return Identity.

    1. read Authorization: Bearer <token>
    2. K8s TokenReview (audience = settings.token_audience)
    3. parse SA username -> Identity(conversation_id, namespace, service_account)
    Raises HTTPException(401) on any failure.
    """
    ...
