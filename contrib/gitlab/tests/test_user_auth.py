"""GitLab user auth: profiles, SSH key registration, the bot identity, and the provider wiring."""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import parse_qs

import httpx
import pytest

from scooter_broker_lib import commit_identity, ssh_keys
from scooter_broker_lib.authz import NoopAuthorizer
from scooter_broker_lib.commit_identity import Person
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.sources.user_first import UserFirstSource
from scooter_broker_lib.testing import assert_rows_match_schema_sql, create_schema, sqlite_config
from scooter_broker_lib.user_auth import ForgeAuthError, Profile, Tokens, UserAuth
from scooter_broker_lib.user_secrets import KeyRing, SecretBox
from scooter_contrib_gitlab import user_auth
from scooter_contrib_gitlab.broker_provider import gitlab

ROOT = Path(__file__).resolve().parents[1]
KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample alice (scooter)"
OLD = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOld alice (scooter)"


class FakeGitLab:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, object]] = []

    def handler(self, req: httpx.Request) -> httpx.Response:
        ctype = req.headers.get("content-type", "")
        body = json.loads(req.content) if ctype.startswith("application/json") else parse_qs(req.content.decode())
        self.calls.append((req.method, req.url.path, body))
        auth = req.headers.get("authorization", "")
        if req.url.path == "/api/v4/user":
            if auth == "Bearer good":
                return httpx.Response(200, json={"username": "alice", "id": 5, "name": "Alice"})
            if auth == "Bearer deploy":
                return httpx.Response(200, json={"username": "scooter-bot", "id": 9, "name": ""})
            return httpx.Response(401)
        if req.url.path == "/api/v4/user/keys" and req.method == "POST":
            return httpx.Response(201, json={"id": 3})
        if req.url.path == "/api/v4/user/keys" and req.method == "GET":
            return httpx.Response(200, json=[{"id": 2, "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOld old"}])
        if req.url.path.startswith("/api/v4/user/keys/") and req.method == "DELETE":
            return httpx.Response(204)
        if req.url.path == "/oauth/revoke":
            return httpx.Response(200, json={})
        return httpx.Response(404)


@pytest.fixture
def gl() -> FakeGitLab:
    return FakeGitLab()


@pytest.fixture
def users(gl) -> user_auth.GitLabUsers:
    return user_auth.GitLabUsers(host="gitlab.com", client_id="cid", client_secret="cs", transport=httpx.MockTransport(gl.handler))


def test_the_row_model_matches_schema_sql():
    assert_rows_match_schema_sql(user_auth.Base, ROOT / "sql" / "schema.sql")


async def test_the_profile_uses_the_noreply_address(users):
    profile = await users.profile("good")
    assert (profile.login, profile.name, profile.email) == ("alice", "Alice", "5-alice@users.noreply.gitlab.com")


async def test_a_refused_token_is_a_forge_auth_error(users):
    with pytest.raises(ForgeAuthError):
        await users.profile("bad")


async def test_the_ssh_key_is_added_for_auth_without_its_comment(users, gl):
    await users.add_ssh_key("good", KEY)
    assert gl.calls[-1] == (
        "POST", "/api/v4/user/keys",
        {"title": "Scooter", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample", "usage_type": "auth"},
    )


async def test_removing_deletes_only_the_matching_key(users, gl):
    await users.remove_ssh_key("good", OLD)
    assert any(m == "DELETE" and p == "/api/v4/user/keys/2" for m, p, _ in gl.calls)
    gl.calls.clear()
    await users.remove_ssh_key("good", KEY)
    assert not any(m == "DELETE" for m, _, _ in gl.calls)


async def test_revoke_sends_the_client_credentials(users, gl):
    await users.revoke("tok")
    method, path, body = gl.calls[-1]
    assert (method, path) == ("POST", "/oauth/revoke")
    assert body == {"client_id": ["cid"], "client_secret": ["cs"], "token": ["tok"]}


def test_the_oauth_endpoints_follow_the_host():
    f = user_auth.GitLabUsers(host="gitlab.example.com", client_id="c", client_secret="s").forge("https://x/cb")
    assert f.authorize_url == "https://gitlab.example.com/oauth/authorize"
    assert f.token_url == "https://gitlab.example.com/oauth/token"
    assert f.scopes == ("api",)


async def test_the_bot_is_the_deployment_tokens_account(users):
    bot = user_auth.GitLabBot(users, "deploy")
    assert await bot.person() == Person("scooter-bot", "9-scooter-bot@users.noreply.gitlab.com")


async def test_a_key_change_swaps_the_key_on_the_linked_account(users, gl):
    class Auth:
        async def access_token(self, user):
            return "good" if user == "alice" else None

    await user_auth.on_key_change(Auth(), users, ssh_keys.SshKeyChange(user="alice", new=KEY, old=OLD))  # type: ignore[arg-type]
    paths = [(m, p) for m, p, _ in gl.calls]
    assert ("DELETE", "/api/v4/user/keys/2") in paths and ("POST", "/api/v4/user/keys") in paths
    gl.calls.clear()
    await user_auth.on_key_change(Auth(), users, ssh_keys.SshKeyChange(user="bob", new=KEY))  # type: ignore[arg-type]
    assert gl.calls == []


# -- provider wiring -----------------------------------------------------------


def _ctx() -> BrokerContext:
    async def fetch(conv):
        return None

    return BrokerContext(
        authorizer=NoopAuthorizer(),
        store_config=sqlite_config(),
        owners=OwnerResolver(fetch),
        user_secrets=SecretBox.of(KeyRing.generate()),
    )


@pytest.fixture
def token_env(monkeypatch):
    monkeypatch.setenv("GITLAB_TOKEN", "glpat-deployment")


def test_user_auth_off_keeps_the_deployment_token(token_env, monkeypatch):
    monkeypatch.setenv("GITLAB_USER_AUTH_ENABLED", "false")
    p = gitlab(_ctx())
    assert not isinstance(p.credential, UserFirstSource)
    assert not any(isinstance(t, UserAuth) for t in p.transports)


def test_user_auth_on_acts_as_the_user_first(token_env, monkeypatch):
    monkeypatch.setenv("GITLAB_USER_AUTH_ENABLED", "true")
    p = gitlab(_ctx())
    assert isinstance(p.credential, UserFirstSource)
    # Mounted before the http-proxy, whose catch-all would otherwise take /user/*.
    assert isinstance(p.transports[0], UserAuth)


def test_without_a_deployment_token_gitlab_stays_off(monkeypatch):
    monkeypatch.delenv("GITLAB_TOKEN", raising=False)
    monkeypatch.setenv("GITLAB_USER_AUTH_ENABLED", "true")
    assert gitlab(_ctx()).enabled is False


async def test_the_commit_identity_names_a_linked_user(token_env, monkeypatch):
    monkeypatch.setenv("GITLAB_USER_AUTH_ENABLED", "true")
    auth = gitlab(_ctx()).transports[0]
    await create_schema(auth, user_auth.Base)
    await auth._save("alice", "pat", Profile("alice", "Alice", "5-alice@users.noreply.gitlab.com"), Tokens("x"))
    person = await commit_identity._sources["scooter_contrib_gitlab.broker_provider._register_commit_identity.<locals>._gitlab_identity"]("alice")
    assert person == Person("Alice", "5-alice@users.noreply.gitlab.com")
