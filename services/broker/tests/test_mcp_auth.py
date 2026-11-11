"""authenticate_mcp, the two-token path, executed for real with a faked TokenReview.

The property every test here circles: a caller cannot choose its own conversation, since
the id comes from a signature the platform made or from the SA name the API server
vouched for.
"""

from __future__ import annotations

import time

import jwt
import pytest
from fastapi import HTTPException
from starlette.requests import Request

from broker.core import auth as auth_mod
from broker.core.conv_token import CONV_TOKEN_AUDIENCE, CONV_TOKEN_ISSUER

SECRET = "mcp-test-secret"
AGENT_HOST = "system:serviceaccount:agent-sandbox:agent-host"


class _User:
    def __init__(self, username): self.username = username


class _Status:
    def __init__(self, username): self.authenticated, self.user = True, _User(username)


class _Result:
    def __init__(self, username): self.status = _Status(username)


class _Api:
    def __init__(self, username): self._u = username
    def create_token_review(self, _review, **_kw): return _Result(self._u)


def _request(conv_token: str | None = None) -> Request:
    headers = [(b"authorization", b"Bearer sa-token")]
    if conv_token is not None:
        headers.append((b"x-scooter-conversation", conv_token.encode()))
    return Request({"type": "http", "method": "POST", "path": "/mcp", "headers": headers})


def _conv_token(conversation_id: str, *, secret: str = SECRET, owner: str | None = None, **over) -> str:
    claims = {
        "aud": CONV_TOKEN_AUDIENCE,
        "iss": CONV_TOKEN_ISSUER,
        "sub": conversation_id,
        "iat": int(time.time()) - 10,
        "exp": int(time.time()) + 3600,
    }
    if owner:
        claims["owner"] = owner
    claims.update(over)
    return jwt.encode(claims, secret, algorithm="HS256")


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "sandbox_namespace", "agent-sandbox")
    monkeypatch.setattr(auth_mod.settings, "mcp_caller_service_accounts", AGENT_HOST)
    monkeypatch.setattr(auth_mod.settings, "conv_token_secret", SECRET)


@pytest.fixture
def _as(monkeypatch):
    def _install(username):
        monkeypatch.setattr(auth_mod, "_api", lambda: _Api(username))
    return _install


# --- the control-plane path -------------------------------------------------------

async def test_control_plane_acts_for_the_conversation_in_its_token(_as):
    _as(AGENT_HOST)
    identity = await auth_mod.authenticate_mcp(_request(_conv_token("conv-7", owner="a@b.c")))
    assert identity.conversation_id == "conv-7"
    assert identity.owner == "a@b.c"
    assert identity.service_account == AGENT_HOST


async def test_control_plane_WITHOUT_a_conversation_token_is_refused(_as):
    """No conversation is defaulted, since there is no safe one to pick."""
    _as(AGENT_HOST)
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate_mcp(_request())
    assert e.value.status_code == 403
    assert "x-scooter-conversation" in e.value.detail


@pytest.mark.parametrize(
    "token_kwargs",
    [
        {"secret": "wrong-secret"},                 # forged
        {"aud": "remote-agent"},                    # a BYOC join token replayed
        {"iss": "somebody-else"},                   # foreign issuer
        {"exp": int(time.time()) - 1},              # expired
    ],
)
async def test_control_plane_with_an_unusable_conversation_token_is_refused(_as, token_kwargs):
    _as(AGENT_HOST)
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate_mcp(_request(_conv_token("conv-7", **token_kwargs)))
    assert e.value.status_code == 403


async def test_the_refusal_does_not_say_WHY(_as):
    """The reason goes to the log, not the 403 body."""
    _as(AGENT_HOST)
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate_mcp(_request(_conv_token("conv-7", secret="wrong")))
    assert e.value.detail == "invalid conversation token"


async def test_a_non_allowlisted_sa_cannot_use_a_conversation_token(_as):
    """A valid conversation token is not enough on its own: a sandbox SA for conv-a presenting a good token for conv-b must not become conv-b."""
    _as("system:serviceaccount:agent-sandbox:sandbox-conv-a")
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate_mcp(_request(_conv_token("conv-b")))
    assert e.value.status_code == 403
    assert "does not match" in e.value.detail


async def test_the_approver_list_does_NOT_grant_mcp_access(_as, monkeypatch):
    """An SA that may relay a human's approve/deny must not thereby act as any conversation."""
    monkeypatch.setattr(auth_mod.settings, "mcp_caller_service_accounts", "")
    monkeypatch.setattr(auth_mod.settings, "approver_service_accounts", AGENT_HOST)
    _as(AGENT_HOST)
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate_mcp(_request(_conv_token("conv-7")))
    assert e.value.status_code == 403
    assert "not permitted on the MCP endpoint" in e.value.detail


async def test_fails_closed_when_no_conv_token_secret_is_configured(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "conv_token_secret", "")
    _as(AGENT_HOST)
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate_mcp(_request(_conv_token("conv-7")))
    assert e.value.status_code == 403


# --- the sandbox path -------------------------------------------------------------

async def test_a_sandbox_sa_resolves_from_its_own_name(_as):
    """No conversation token is needed, since the SA name already binds it to one conversation."""
    _as("system:serviceaccount:agent-sandbox:sandbox-conv-9")
    identity = await auth_mod.authenticate_mcp(_request())
    assert identity.conversation_id == "conv-9"
    assert identity.owner is None


async def test_a_sandbox_may_present_a_matching_conversation_token(_as):
    _as("system:serviceaccount:agent-sandbox:sandbox-conv-9")
    identity = await auth_mod.authenticate_mcp(_request(_conv_token("conv-9")))
    assert identity.conversation_id == "conv-9"


async def test_a_sandbox_from_another_namespace_is_refused(_as, monkeypatch):
    _as("system:serviceaccount:somewhere-else:sandbox-conv-9")
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate_mcp(_request())
    assert e.value.status_code == 403


async def test_an_unrelated_sa_is_refused(_as):
    _as("system:serviceaccount:kube-system:default")
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate_mcp(_request())
    assert e.value.status_code == 403


async def test_a_missing_bearer_token_is_a_401(_as):
    _as(AGENT_HOST)
    req = Request({"type": "http", "method": "POST", "path": "/mcp", "headers": []})
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate_mcp(req)
    assert e.value.status_code == 401
