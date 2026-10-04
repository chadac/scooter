"""Caller authentication — validate the pod's projected SA token via K8s
TokenReview and extract the Identity.

Unchanged model from openhands-nix: the pod presents a projected ServiceAccount
token (audience agent-broker); we validate it and parse the SA username
`system:serviceaccount:{ns}:sandbox-{conversationId}`.
"""

from __future__ import annotations

import logging
import re

from fastapi import HTTPException, Request
from kubernetes import client, config

from scooter_broker_lib.types import Identity
from ..config import settings
from .conv_token import CONV_TOKEN_HEADER, ConvTokenError, verify_conv_token

logger = logging.getLogger(__name__)

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


async def _review(token: str) -> str:
    """Validate a projected SA token via TokenReview and return its SA username.

    Extracted so the MCP endpoint's two-token path (authenticate_mcp, below) shares
    exactly this validation rather than reimplementing it — the audience pin in
    particular, which is what stops a token minted for some other audience being
    replayed at the broker.
    """
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

    return status.user.username if status.user else ""


async def authenticate(request: Request) -> Identity:
    """FastAPI dependency: validate the Bearer SA token and return Identity."""
    token = _bearer(request)
    username = await _review(token)

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
    approvers = {s.strip() for s in settings.approver_service_accounts.split(",") if s.strip()}
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


# ---------------------------------------------------------------------------
# MCP: the two-token path
# ---------------------------------------------------------------------------
#
# The agent-facing MCP endpoint cannot use `authenticate` above, for a reason that is
# the whole point of issue #700: an SA token identifies the CALLER, and for the
# control plane the caller is one agent-host serving every conversation. Admitting it
# as an approver (conversation_id="") is what makes a tool call anonymous as to
# conversation — so the auto-link never fires — and trusting a caller-supplied id
# instead is what let anything reaching the port name any conversation.
#
# So the MCP endpoint requires BOTH credentials and derives the conversation from the
# one that is cryptographically bound to it:
#
#   control plane  Authorization: Bearer <agent-host SA token>   (TokenReview, must be
#                                                                 in mcp_caller_*)
#                  X-Scooter-Conversation: <conversation token>  (signed; THE id)
#
#   the sandbox    Authorization: Bearer <sandbox SA token>      -> id from the SA name
#                                                                 sandbox-<id>, the
#                                                                 existing path
#
# A sandbox needs no conversation token: its SA name already binds it to exactly one
# conversation, and it cannot obtain another conversation's SA token. A control-plane
# caller presenting NO conversation token is rejected rather than defaulted — there is
# no safe conversation to pick, and an endpoint that picks one is the hole.


def _mcp_callers() -> set[str]:
    """SA usernames allowed to act FOR a conversation via a conversation token.

    Deliberately NOT `approver_service_accounts`. That list means "may relay a human's
    approve/deny decision" and happens to name the agent-host today; reusing it would
    make "may act as any conversation" an accidental consequence of an unrelated
    setting. The two authorizations are different questions about the same SA, and
    #700 hit the inverse of this: `github_comment` 403s on a deployment that never set
    the approver list, because an integration tool was silently depending on it.
    """
    return {s.strip() for s in settings.mcp_caller_service_accounts.split(",") if s.strip()}


async def authenticate_mcp(request: Request) -> Identity:
    """FastAPI dependency for the MCP endpoint. Returns an Identity whose
    conversation_id is always bound to the presented credentials."""
    token = _bearer(request)
    username = await _review(token)

    # Control plane: an allowlisted non-sandbox caller, acting for the conversation
    # named by its conversation token.
    if username in _mcp_callers():
        conv_token = request.headers.get(CONV_TOKEN_HEADER, "").strip()
        if not conv_token:
            raise HTTPException(
                status_code=403,
                detail=(
                    "a control-plane caller must present a conversation token in "
                    f"{CONV_TOKEN_HEADER}"
                ),
            )
        try:
            verified = verify_conv_token(conv_token, settings.conv_token_secret)
        except ConvTokenError as exc:
            # The REASON goes to our log only: a 403 body distinguishing "expired"
            # from "bad signature" tells an attacker which half to work on.
            logger.warning(
                "rejected an MCP conversation token",
                extra={"service_account": username, "reason": str(exc)},
            )
            raise HTTPException(status_code=403, detail="invalid conversation token") from exc
        return Identity(
            conversation_id=verified.conversation_id,
            namespace=settings.sandbox_namespace,
            service_account=username,
            owner=verified.owner,
        )

    # The sandbox itself: the SA name is the binding, so no second token is needed.
    m = _SA_PATTERN.match(username or "")
    if not m:
        raise HTTPException(status_code=403, detail=f"not permitted on the MCP endpoint: {username}")
    namespace, conversation_id = m.group(1), m.group(2)
    if namespace != settings.sandbox_namespace:
        raise HTTPException(status_code=403, detail="wrong namespace")

    # A sandbox presenting a conversation token for a DIFFERENT conversation is a
    # confused or hostile caller either way; its SA wins and the mismatch is refused
    # rather than silently resolved in favour of one of them.
    conv_token = request.headers.get(CONV_TOKEN_HEADER, "").strip()
    if conv_token:
        try:
            verified = verify_conv_token(conv_token, settings.conv_token_secret)
        except ConvTokenError as exc:
            raise HTTPException(status_code=403, detail="invalid conversation token") from exc
        if verified.conversation_id != conversation_id:
            raise HTTPException(
                status_code=403,
                detail="conversation token does not match the calling sandbox",
            )

    return Identity(
        conversation_id=conversation_id,
        namespace=namespace,
        service_account=username,
    )
