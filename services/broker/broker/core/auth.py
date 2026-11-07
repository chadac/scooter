"""Caller authentication: validate a projected SA token via K8s TokenReview and parse the
SA username `system:serviceaccount:{ns}:sandbox-{conversationId}` into an Identity."""

from __future__ import annotations

import logging

from fastapi import HTTPException, Request
from kubernetes import client, config
from scooter_lib.svcauth import Review, Verifier, bearer_token, parse_allowlist, sandbox_id

from scooter_broker_lib.types import Identity
from ..config import settings
from .conv_token import CONV_TOKEN_HEADER, ConvTokenError, verify_conv_token
from .user_assertion import USER_ASSERTION_HEADER, UserAssertionError, verify_user_assertion

logger = logging.getLogger(__name__)

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


async def _kube_review(token: str) -> Review:
    review = client.V1TokenReview(
        spec=client.V1TokenReviewSpec(token=token, audiences=[settings.token_audience])
    )
    status = _api().create_token_review(review).status
    if not status or not status.authenticated:
        return Review(ok=False)
    return Review(ok=True, username=status.user.username if status.user else "")


_verifier = Verifier(_kube_review)


def _bearer(request: Request) -> str:
    token = bearer_token(request.headers)
    if not token:
        raise HTTPException(status_code=401, detail="missing bearer token")
    return token


async def _review(token: str) -> str:
    """Validate a projected SA token via TokenReview, pinned to the broker audience, and return its SA username."""
    try:
        verdict = await _verifier.verify(token)
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=502, detail="token review failed") from exc
    if not verdict.ok:
        raise HTTPException(status_code=401, detail="token not authenticated")
    return verdict.username


def _sandbox_conversation(username: str) -> str:
    """The conversation a sandbox SA is bound to; 403 for anything else."""
    conversation_id = sandbox_id(username, settings.sandbox_namespace)
    if not conversation_id:
        raise HTTPException(status_code=403, detail=f"not a sandbox SA in this namespace: {username}")
    return conversation_id


RELAYED_USER_HEADER = "x-scooter-user"


def _csv(raw: str) -> frozenset[str]:
    return parse_allowlist(raw)


def _relayed_user(request: Request, username: str) -> str | None:
    """The user named in X-Scooter-User, trusted only from a user-relay account; None from anyone else."""
    if username not in _csv(settings.user_relay_service_accounts):
        return None
    user = request.headers.get(RELAYED_USER_HEADER, "").strip()
    return user or None


async def _relayed_approver(request: Request) -> object:
    """The JSON body's `approver`, or None when the body has none."""
    if request.method in ("GET", "HEAD", "DELETE"):
        return None
    try:
        body = await request.json()
    except ValueError:
        return None
    return body.get("approver") if isinstance(body, dict) else None


async def _check_user_assertion(request: Request, username: str) -> None:
    """403 unless a relayed approver comes with a router assertion vouching for it."""
    if not settings.user_assertion_secret:
        return
    approver = await _relayed_approver(request)
    if approver is None:
        return
    try:
        asserted = verify_user_assertion(
            request.headers.get(USER_ASSERTION_HEADER, "").strip(), settings.user_assertion_secret)
    except UserAssertionError as exc:
        # The reason goes to the log only, never the 403 body.
        logger.warning("rejected a user assertion", extra={"service_account": username, "reason": str(exc)})
        raise HTTPException(status_code=403, detail="approver not proven") from exc
    if not asserted.vouches_for(approver):
        logger.warning("user assertion names another user", extra={"service_account": username})
        raise HTTPException(status_code=403, detail="approver not proven")


async def authenticate(request: Request) -> Identity:
    """FastAPI dependency: validate the Bearer SA token and return Identity."""
    token = _bearer(request)
    username = await _review(token)

    relayed_user = _relayed_user(request, username)

    # Approver SAs are not sandboxes: they have no conversation_id but may approve.
    approvers = _csv(settings.approver_service_accounts)
    if username in approvers:
        await _check_user_assertion(request, username)
        return Identity(conversation_id="", namespace=settings.sandbox_namespace,
                        service_account=username, is_approver=True,
                        relayed_user=relayed_user)

    if username in _csv(settings.system_task_service_accounts):
        # The scheduler, running a system task: no conversation and no user, and never an approver.
        return Identity(conversation_id="", namespace=settings.sandbox_namespace,
                        service_account=username, is_system_task=True)

    if username in _csv(settings.user_relay_service_accounts):
        # A relay account that is not also an approver is still not a sandbox; without
        # the header it names nobody, and user routes refuse it.
        return Identity(conversation_id="", namespace=settings.sandbox_namespace,
                        service_account=username, relayed_user=relayed_user)

    conversation_id = _sandbox_conversation(username)
    return Identity(
        conversation_id=conversation_id,
        namespace=settings.sandbox_namespace,
        service_account=username,
    )


# ---------------------------------------------------------------------------
# MCP: the two-token path
# ---------------------------------------------------------------------------
#
# An SA token identifies the caller, and for the control plane that is one agent-host
# serving every conversation, so the MCP endpoint derives the conversation from the
# credential cryptographically bound to it: a control-plane caller presents its SA token
# (TokenReview, allowlisted in mcp_caller_service_accounts) plus a signed conversation
# token in X-Scooter-Conversation, while a sandbox's own SA name already binds it to
# exactly one conversation. A control-plane caller without a conversation token is
# rejected rather than defaulted.


def _mcp_callers() -> set[str]:
    """SA usernames allowed to act for a conversation via a conversation token, a separate authorization from `approver_service_accounts`."""
    return {s.strip() for s in settings.mcp_caller_service_accounts.split(",") if s.strip()}


async def authenticate_mcp(request: Request) -> Identity:
    """FastAPI dependency for the MCP endpoint, returning an Identity whose conversation_id is bound to the presented credentials."""
    token = _bearer(request)
    username = await _review(token)

    # Control plane: an allowlisted caller acting for the conversation its token names.
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
            # The reason goes to the log only, never the 403 body.
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

    # The sandbox itself: the SA name is the binding.
    conversation_id = sandbox_id(username, settings.sandbox_namespace)
    if not conversation_id:
        raise HTTPException(status_code=403, detail=f"not permitted on the MCP endpoint: {username}")

    # A conversation token naming a different conversation than the SA is refused.
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
        namespace=settings.sandbox_namespace,
        service_account=username,
    )


# ---------------------------------------------------------------------------
# The forge proxy: a sandbox SA token presented as Proxy-Authorization on CONNECT
# ---------------------------------------------------------------------------


async def sandbox_identity(token: str) -> Identity:
    """Validate a sandbox's SA token outside a FastAPI request; only sandboxes (not approvers) are admitted."""
    username = await _review(token)
    conversation_id = sandbox_id(username, settings.sandbox_namespace)
    if not conversation_id:
        raise HTTPException(status_code=403, detail="the forge proxy serves sandboxes only")
    return Identity(conversation_id=conversation_id, namespace=settings.sandbox_namespace, service_account=username)
