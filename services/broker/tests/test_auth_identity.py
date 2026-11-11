"""The real authenticate() body, executed directly with a faked TokenReview so its settings reads happen for real."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from broker.core import auth as auth_mod


class _User:
    def __init__(self, username): self.username = username


class _Status:
    def __init__(self, username): self.authenticated, self.user = True, _User(username)


class _Result:
    def __init__(self, username): self.status = _Status(username)


class _Api:
    def __init__(self, username): self._u = username
    def create_token_review(self, _review, **_kw): return _Result(self._u)


def _request() -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/", "headers": [(b"authorization", b"Bearer t")],
    })


@pytest.fixture
def _as(monkeypatch):
    def _install(username):
        monkeypatch.setattr(auth_mod, "_api", lambda: _Api(username))
    return _install


async def test_a_sandbox_sa_authenticates(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "sandbox_namespace", "agent-sandbox")
    _as("system:serviceaccount:agent-sandbox:sandbox-conv-1")
    identity = await auth_mod.authenticate(_request())
    assert identity.conversation_id == "conv-1"
    assert not identity.is_approver


async def test_an_approver_sa_authenticates(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "approver_service_accounts",
                        "system:serviceaccount:agent-sandbox:agent-host")
    _as("system:serviceaccount:agent-sandbox:agent-host")
    identity = await auth_mod.authenticate(_request())
    assert identity.is_approver
    assert identity.conversation_id == ""


async def test_a_stranger_is_rejected(_as):
    _as("system:serviceaccount:other:nobody")
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate(_request())
    assert e.value.status_code == 403


# --- The /contrib-api relay: X-Scooter-User is trusted only from a relay account -----

HOST = "system:serviceaccount:agent-sandbox:agent-host"


def _relayed(user: str) -> Request:
    return Request({
        "type": "http", "method": "GET", "path": "/",
        "headers": [(b"authorization", b"Bearer t"), (b"x-scooter-user", user.encode())],
    })


async def test_the_relay_account_names_the_user(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "approver_service_accounts", HOST)
    monkeypatch.setattr(auth_mod.settings, "user_relay_service_accounts", HOST)
    _as(HOST)
    identity = await auth_mod.authenticate(_relayed("alice"))
    assert identity.relayed_user == "alice"
    assert identity.conversation_id == ""


async def test_a_relay_account_need_not_be_an_approver(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "approver_service_accounts", "")
    monkeypatch.setattr(auth_mod.settings, "user_relay_service_accounts", HOST)
    _as(HOST)
    identity = await auth_mod.authenticate(_relayed("alice"))
    assert identity.relayed_user == "alice"
    assert not identity.is_approver


async def test_a_sandbox_cannot_name_a_user(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "sandbox_namespace", "agent-sandbox")
    monkeypatch.setattr(auth_mod.settings, "user_relay_service_accounts", HOST)
    _as("system:serviceaccount:agent-sandbox:sandbox-conv-1")
    identity = await auth_mod.authenticate(_relayed("alice"))
    assert identity.conversation_id == "conv-1"
    assert identity.relayed_user is None


async def test_an_approver_that_is_not_a_relay_cannot_name_a_user(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "approver_service_accounts", HOST)
    monkeypatch.setattr(auth_mod.settings, "user_relay_service_accounts", "")
    _as(HOST)
    identity = await auth_mod.authenticate(_relayed("alice"))
    assert identity.is_approver
    assert identity.relayed_user is None


# --- System tasks: the scheduler's account calls /system routes -------------------------

SCHEDULER = "system:serviceaccount:agent-sandbox:agent-scheduler"


async def test_the_scheduler_authenticates_as_a_system_task(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "system_task_service_accounts", SCHEDULER)
    monkeypatch.setattr(auth_mod.settings, "user_relay_service_accounts", HOST)
    _as(SCHEDULER)
    identity = await auth_mod.authenticate(_relayed("alice"))
    assert identity.is_system_task
    assert not identity.is_approver and identity.relayed_user is None and identity.conversation_id == ""


async def test_the_scheduler_is_a_stranger_when_not_listed(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "system_task_service_accounts", "")
    _as(SCHEDULER)
    with pytest.raises(HTTPException) as e:
        await auth_mod.authenticate(_request())
    assert e.value.status_code == 403


async def test_a_sandbox_is_never_a_system_task(_as, monkeypatch):
    monkeypatch.setattr(auth_mod.settings, "sandbox_namespace", "agent-sandbox")
    monkeypatch.setattr(auth_mod.settings, "system_task_service_accounts", SCHEDULER)
    _as("system:serviceaccount:agent-sandbox:sandbox-conv-1")
    assert not (await auth_mod.authenticate(_request())).is_system_task
