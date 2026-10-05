"""Conversation-token verification — the broker half of the platform primitive the
agent-host mints (services/agent-host/src/auth/convToken.ts). See issue #700.

WHY THE BROKER NEEDS IT. A tool call arriving from the control plane carries the
agent-host's ServiceAccount token, which says "a trusted platform component is
calling" and nothing about WHICH conversation it is calling for. Today that is why
`core/auth.py` hands such callers `conversation_id=""`, and why `http_proxy`'s
auto-link — gated on `identity.conversation_id` — silently never fires for a
tool-created PR. The conversation token supplies the missing half.

BOTH TOKENS ARE REQUIRED, and they answer different questions:

    SA token    -> is the caller a platform component we trust at all?  (TokenReview,
                   kubelet-rotated, so this is also the FRESHNESS guarantee)
    conv token  -> which conversation is it acting for?                 (signed, long-lived)

Neither alone is sufficient. That is what makes the long conversation-token TTL safe:
a leaked conversation token cannot be used without also holding a current SA token
from an allowlisted caller.

HS256, verified with a FIXED algorithm list. `algorithms=["HS256"]` is what makes the
classic alg-confusion attack impossible — a token whose header asks for `none` or
`RS256` is rejected before any signature work. Never widen that list.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# Must match services/agent-host/src/auth/convToken.ts. The frozen cross-language
# vector in tests/fixtures/conv-token.json is what keeps the two in agreement.
CONV_TOKEN_AUDIENCE = "scooter-mcp"
CONV_TOKEN_ISSUER = "scooter-agent-host"

# The header the control plane carries the conversation token in. Separate from
# `Authorization`, which already carries the SA token — the two credentials are
# independent and must not be multiplexed into one header.
CONV_TOKEN_HEADER = "x-scooter-conversation"


@dataclass(frozen=True)
class ConvToken:
    """The verified claims we actually use."""

    conversation_id: str
    owner: str | None = None


class ConvTokenError(Exception):
    """Verification failed. The message is for the BROKER'S log, not the caller: a
    401 body that distinguishes "expired" from "bad signature" tells an attacker
    which half to work on."""


def verify_conv_token(token: str, secret: str, now: int | None = None) -> ConvToken:
    """Verify a conversation token and return its claims.

    `now` (seconds since epoch) overrides the clock, defaulting to the real one. The
    expiry check is ours rather than pyjwt's for exactly that reason: pyjwt compares
    against `datetime.now()` with no injection point, so a frozen test vector — which
    must have a FIXED `exp` to be frozen at all — can only be verified by either
    monkeypatching pyjwt's clock or giving the vector an exp far enough in the future
    that it stops testing expiry. Both are worse than two lines of comparison, and
    the TS verifier does its own check too, so the two implementations stay
    symmetrical.

    Raises ConvTokenError for every failure mode — an absent secret included, which
    FAILS CLOSED. Verifying against an empty secret would accept anything an attacker
    signed with an empty secret, so a deployment that forgot to mount the Secret must
    reject every token rather than accept every token.
    """
    if not secret:
        raise ConvTokenError("no conversation-token secret configured")
    if not token:
        raise ConvTokenError("no conversation token presented")

    # Imported here, not at module scope: this keeps `pyjwt` off the import path of
    # every other broker module, matching how the lib avoids dragging a crypto stack
    # in for one feature (see scooter-broker-lib/default.nix).
    import jwt

    try:
        claims = jwt.decode(
            token,
            secret,
            algorithms=["HS256"],          # fixed; see the module docstring
            audience=CONV_TOKEN_AUDIENCE,
            issuer=CONV_TOKEN_ISSUER,
            # `require` is a PRESENCE check and stays on for exp even though we
            # verify it ourselves below — a token with no exp must be rejected, not
            # treated as never expiring.
            options={
                "require": ["exp", "iat", "sub", "aud", "iss"],
                "verify_exp": False,
            },
        )
    except jwt.InvalidTokenError as exc:
        # One exception type out, with the reason only in the log.
        raise ConvTokenError(f"invalid conversation token: {exc}") from exc

    # Expiry, against an injectable clock. `<=` so a token is dead ON its exp second,
    # matching verifyConvToken in the agent-host.
    import time

    exp = claims.get("exp")
    if not isinstance(exp, (int, float)):
        raise ConvTokenError("conversation token has a non-numeric exp")
    if exp <= (now if now is not None else int(time.time())):
        raise ConvTokenError("conversation token has expired")

    conversation_id = claims.get("sub") or ""
    if not isinstance(conversation_id, str) or not conversation_id:
        raise ConvTokenError("conversation token carries no conversation")

    owner = claims.get("owner")
    return ConvToken(
        conversation_id=conversation_id,
        owner=owner if isinstance(owner, str) and owner else None,
    )
