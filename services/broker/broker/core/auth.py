"""Caller authentication — validate the pod's projected SA token via K8s
TokenReview and extract the Identity.

Unchanged model from openhands-nix: the pod presents a projected ServiceAccount
token (audience agent-broker); we validate it and parse the SA username
`system:serviceaccount:{ns}:sandbox-{conversationId}`.
"""

from __future__ import annotations

import re

from fastapi import HTTPException, Request
from kubernetes import client, config

from scooter_broker_lib.types import Identity
from ..config import settings

# SA username pattern: system:serviceaccount:{ns}:sandbox-{conversationId}
_SA_PATTERN = re.compile(r"^system:serviceaccount:([^:]+):sandbox-(.+)$")

_authn_api: client.AuthenticationV1Api | None = None


def _api() -> client.AuthenticationV1Api:
    global _authn_api
    if _authn_api is None:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        _authn_api = client.AuthenticationV1Api()
    return _authn_api


def _bearer(request: Request) -> str:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    return header[len("bearer "):].strip()


async def authenticate(request: Request) -> Identity:
    """FastAPI dependency: validate the Bearer SA token and return Identity."""
    token = _bearer(request)

    review = client.V1TokenReview(
        spec=client.V1TokenReviewSpec(
            token=token,
            audiences=[settings.token_audience],
        )
    )
    try:
        result = _api().create_token_review(review)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=502, detail="token review failed") from exc

    status = result.status
    if not status or not status.authenticated:
        raise HTTPException(status_code=401, detail="token not authenticated")

    username = status.user.username if status.user else ""

    # Approver SAs (e.g. the agent-host relaying a user's approve/deny) aren't
    # sandboxes — they have no conversation_id but may approve, so they are
    # admitted here rather than failing the _SA_PATTERN check below.
    #
    # This used to union a second list, sandbox_control_service_accounts, for the
    # agent-host driving the broker's sandbox-lifecycle API. #584 moved that API
    # to the agent-host and deleted the setting, but left this read — and pydantic
    # raises AttributeError for a field that isn't declared, so EVERY caller got a
    # 500 here. Don't reintroduce the union: the broker has no lifecycle API to
    # gate, and the agent-host authenticates via the approver list above.
    approvers = {s.strip() for s in settings.aws_approver_service_accounts.split(",") if s.strip()}
    if username in approvers:
        return Identity(conversation_id="", namespace=settings.sandbox_namespace,
                        service_account=username, is_approver=True)

    m = _SA_PATTERN.match(username or "")
    if not m:
        raise HTTPException(status_code=403, detail=f"not a sandbox SA: {username}")

    namespace, conversation_id = m.group(1), m.group(2)
    if namespace != settings.sandbox_namespace:
        raise HTTPException(status_code=403, detail="wrong namespace")

    return Identity(
        conversation_id=conversation_id,
        namespace=namespace,
        service_account=username,
    )
