"""Conversation-token verification (issue #700).

The frozen-vector tests are the cross-language contract: the SAME token and secret
are verified by `services/agent-host/test/contract/convToken.spec.ts`. If the
agent-host's encoding drifts, this file fails — which is the only way a Python
verifier can notice a TypeScript signer changing shape.

scripts/check-conv-token-vector.sh keeps the two committed copies of the fixture
byte-identical, since the two nix derivations build from separate source trees and
cannot share a path.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from broker.core.conv_token import (
    CONV_TOKEN_AUDIENCE,
    CONV_TOKEN_ISSUER,
    ConvTokenError,
    verify_conv_token,
)

VECTOR = json.loads((Path(__file__).parent / "fixtures" / "conv-token.json").read_text())

SECRET = "a-test-secret"


def _mint(claims: dict, secret: str = SECRET, alg: str = "HS256") -> str:
    import jwt

    return jwt.encode(claims, secret, algorithm=alg)


def _claims(**over) -> dict:
    base = {
        "aud": CONV_TOKEN_AUDIENCE,
        "iss": CONV_TOKEN_ISSUER,
        "sub": "conv-1",
        "iat": 1_700_000_000,
        "exp": 4_000_000_000,
    }
    base.update(over)
    return base


# --- the cross-language vector ---------------------------------------------------

def test_verifies_the_frozen_agent_host_token():
    """The committed token was signed by the TypeScript implementation.

    The clock is pinned: a frozen vector has a fixed `exp`, so verifying it against
    the real clock would start failing the moment that timestamp passed."""
    res = verify_conv_token(VECTOR["token"], VECTOR["secret"], now=VECTOR["verifyAtEpochSeconds"])
    assert res.conversation_id == VECTOR["claims"]["sub"]
    assert res.owner == VECTOR["claims"]["owner"]


def test_frozen_vector_is_rejected_under_the_wrong_secret():
    with pytest.raises(ConvTokenError):
        verify_conv_token(VECTOR["token"], "not-the-secret", now=VECTOR["verifyAtEpochSeconds"])


def test_frozen_vector_is_expired_past_its_exp():
    """The other half of pinning the clock: the TS suite asserts this too."""
    with pytest.raises(ConvTokenError, match="expired"):
        verify_conv_token(VECTOR["token"], VECTOR["secret"], now=VECTOR["expiredAtEpochSeconds"])


# --- the negative cases that make this a security boundary ------------------------

def test_round_trips_sub_and_owner():
    res = verify_conv_token(_mint(_claims(owner="bob@example.com")), SECRET)
    assert res.conversation_id == "conv-1"
    assert res.owner == "bob@example.com"


def test_owner_is_none_when_absent():
    assert verify_conv_token(_mint(_claims()), SECRET).owner is None


def test_rejects_a_token_signed_with_another_secret():
    with pytest.raises(ConvTokenError):
        verify_conv_token(_mint(_claims(), secret="other"), SECRET)


def test_rejects_a_repointed_conversation():
    """Tamper with `sub` and keep the original signature."""
    token = _mint(_claims(sub="conv-victim"))
    header, payload, sig = token.split(".")
    import base64

    def b64d(s: str) -> bytes:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

    claims = json.loads(b64d(payload))
    claims["sub"] = "conv-attacker"
    forged_payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    with pytest.raises(ConvTokenError):
        verify_conv_token(f"{header}.{forged_payload}.{sig}", SECRET)


def test_rejects_alg_none():
    """The fixed algorithms=["HS256"] list is what makes this unreachable."""
    import jwt

    unsigned = jwt.encode(_claims(), key="", algorithm="none")
    with pytest.raises(ConvTokenError):
        verify_conv_token(unsigned, SECRET)


def test_rejects_a_byoc_join_token_replayed_here():
    with pytest.raises(ConvTokenError):
        verify_conv_token(_mint(_claims(aud="remote-agent")), SECRET)


def test_rejects_a_foreign_issuer():
    with pytest.raises(ConvTokenError):
        verify_conv_token(_mint(_claims(iss="somebody-else")), SECRET)


def test_rejects_an_expired_token():
    with pytest.raises(ConvTokenError, match="expired"):
        verify_conv_token(_mint(_claims(exp=1_000)), SECRET, now=1_000)


def test_accepts_a_token_one_second_before_expiry():
    """`<=` on the boundary second, matching verifyConvToken in the agent-host."""
    assert verify_conv_token(_mint(_claims(exp=1_100)), SECRET, now=1_099).conversation_id == "conv-1"


@pytest.mark.parametrize("missing", ["exp", "iat", "sub", "aud", "iss"])
def test_requires_every_load_bearing_claim(missing):
    claims = _claims()
    del claims[missing]
    with pytest.raises(ConvTokenError):
        verify_conv_token(_mint(claims), SECRET)


def test_rejects_malformed_tokens_without_raising_something_else():
    for bad in ["", "nope", "a.b", "a.b.c.d"]:
        with pytest.raises(ConvTokenError):
            verify_conv_token(bad, SECRET)


def test_fails_closed_with_no_secret_configured():
    """A deployment that forgot to mount the Secret must reject EVERY token, not
    accept every token signed with "".

    Minted with a REAL secret: pyjwt refuses to sign with an empty HMAC key, so the
    token an attacker would actually present here is an ordinary signed one that the
    broker simply has no key to check."""
    with pytest.raises(ConvTokenError, match="no conversation-token secret"):
        verify_conv_token(_mint(_claims()), "")
