"""verify_join_token — the security-critical HS256 check the claude-bridge does before proxying.
Must match services/agent-host/src/auth/remoteAgentToken.ts (same alg/claims/audience)."""

import base64
import hashlib
import hmac
import json
import time

from webhooks.claude_bridge import verify_join_token

SECRET = "test-secret-abc"


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def mint(owner: str, secret: str, ttl: int = 600, now: int | None = None) -> str:
    """Mint an HS256 join JWT identical in shape to the TS mintJoinToken."""
    now = now if now is not None else int(time.time())
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    claims = _b64url(
        json.dumps({"owner": owner, "iat": now, "exp": now + ttl, "nonce": "n", "aud": "remote-agent"}).encode()
    )
    sig = _b64url(hmac.new(secret.encode(), f"{header}.{claims}".encode(), hashlib.sha256).digest())
    return f"{header}.{claims}.{sig}"


def test_verifies_and_returns_owner():
    claims = verify_join_token(mint("alice", SECRET), SECRET)
    assert claims is not None
    assert claims["owner"] == "alice"


def test_rejects_wrong_secret():
    assert verify_join_token(mint("alice", SECRET), "other") is None


def test_rejects_tampered_owner():
    tok = mint("alice", SECRET)
    header, _claims, sig = tok.split(".")
    forged = _b64url(json.dumps({"owner": "bob", "iat": 1, "exp": 9999999999, "nonce": "n", "aud": "remote-agent"}).encode())
    assert verify_join_token(f"{header}.{forged}.{sig}", SECRET) is None


def test_rejects_expired():
    past = int(time.time()) - 100
    assert verify_join_token(mint("alice", SECRET, ttl=10, now=past - 10), SECRET) is None


def test_rejects_wrong_audience():
    now = int(time.time())
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    claims = _b64url(json.dumps({"owner": "alice", "iat": now, "exp": now + 600, "nonce": "n", "aud": "other"}).encode())
    sig = _b64url(hmac.new(SECRET.encode(), f"{header}.{claims}".encode(), hashlib.sha256).digest())
    assert verify_join_token(f"{header}.{claims}.{sig}", SECRET) is None


def test_rejects_malformed():
    assert verify_join_token("not.a.jwt", SECRET) is None
    assert verify_join_token("garbage", SECRET) is None
