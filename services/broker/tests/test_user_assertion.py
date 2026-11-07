"""User-assertion verification and its enforcement on approver SAs.

The frozen vector is the cross-language contract with the router's userassertion_test.go;
scripts/check-conv-token-vector.sh keeps the two committed copies byte-identical.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from broker.core import auth as auth_mod
from broker.core.user_assertion import (
    USER_ASSERTION_AUDIENCE,
    USER_ASSERTION_HEADER,
    USER_ASSERTION_ISSUER,
    UserAssertion,
    UserAssertionError,
    verify_user_assertion,
)

VECTOR = json.loads((Path(__file__).parent / "fixtures" / "user-assertion.json").read_text())
SECRET = "a-test-secret"
HOST = "system:serviceaccount:agent-sandbox:agent-host"


def _mint(secret: str = SECRET, **over) -> str:
    import jwt

    claims = {"iss": USER_ASSERTION_ISSUER, "aud": USER_ASSERTION_AUDIENCE, "sub": "alice",
              "email": "alice@example.com", "iat": 1_700_000_000, "exp": 4_000_000_000, **over}
    return jwt.encode(claims, secret, algorithm="HS256")


def test_the_frozen_vector_verifies():
    got = verify_user_assertion(VECTOR["token"], VECTOR["secret"], now=VECTOR["claims"]["iat"])
    assert got == UserAssertion(user=VECTOR["claims"]["sub"], email=VECTOR["claims"]["email"])


def test_the_frozen_vector_expires():
    with pytest.raises(UserAssertionError):
        verify_user_assertion(VECTOR["token"], VECTOR["secret"], now=VECTOR["claims"]["exp"])


@pytest.mark.parametrize("token", [
    _mint(secret="wrong"),
    _mint(aud="scooter-mcp"),
    _mint(iss="scooter-agent-host"),
    "",
])
def test_bad_assertions_are_refused(token):
    with pytest.raises(UserAssertionError):
        verify_user_assertion(token, SECRET)


def test_no_secret_fails_closed():
    with pytest.raises(UserAssertionError):
        verify_user_assertion(_mint(), "")


@pytest.mark.parametrize("approver,ok", [
    ({"id": "alice", "email": "Alice@example.com"}, True),
    ({"id": "alice"}, True),
    ({"id": "alice", "email": "mallory@example.com"}, False),
    ({"id": "mallory"}, False),
    ("user:alice", True),
    ("alice@example.com", True),
    ("mallory@example.com", False),
    (42, False),
])
def test_vouches_only_for_the_asserted_user(approver, ok):
    assert UserAssertion(user="alice", email="alice@example.com").vouches_for(approver) is ok


# --- authenticate(): an approver SA must prove the approver it relays ---------------


class _Api:
    def create_token_review(self, _review):
        user = type("U", (), {"username": HOST})()
        status = type("S", (), {"authenticated": True, "user": user})()
        return type("R", (), {"status": status})()


def _post(body: dict, assertion: str | None = None) -> Request:
    raw = json.dumps(body).encode()
    headers = [(b"authorization", b"Bearer t"), (b"content-type", b"application/json")]
    if assertion is not None:
        headers.append((USER_ASSERTION_HEADER.encode(), assertion.encode()))
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": raw, "more_body": False}

    return Request({"type": "http", "method": "POST", "path": "/", "headers": headers}, receive)


@pytest.fixture
def _enforcing(monkeypatch):
    monkeypatch.setattr(auth_mod, "_api", lambda: _Api())
    monkeypatch.setattr(auth_mod.settings, "approver_service_accounts", HOST)
    monkeypatch.setattr(auth_mod.settings, "user_assertion_secret", SECRET)


async def test_a_proven_approver_is_admitted(_enforcing):
    identity = await auth_mod.authenticate(_post({"approver": {"id": "alice"}}, _mint()))
    assert identity.is_approver


@pytest.mark.parametrize("assertion", [None, "garbage", _mint(sub="mallory", email="m@example.com")])
async def test_an_unproven_approver_is_refused(_enforcing, assertion):
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate(_post({"approver": {"id": "alice"}}, assertion))
    assert e.value.status_code == 403


async def test_a_body_without_an_approver_needs_no_assertion(_enforcing):
    assert (await auth_mod.authenticate(_post({"conversation_id": "c1"}))).is_approver


async def test_the_body_is_still_readable_downstream(_enforcing):
    req = _post({"approver": {"id": "alice"}}, _mint())
    await auth_mod.authenticate(req)
    assert (await req.json())["approver"] == {"id": "alice"}


async def test_no_secret_means_no_enforcement(_enforcing, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "user_assertion_secret", "")
    assert (await auth_mod.authenticate(_post({"approver": {"id": "alice"}}))).is_approver
