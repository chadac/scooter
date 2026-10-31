"""GitHub user auth: profiles, SSH key registration, the bot identity, and the provider wiring."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from scooter_broker_lib import commit_identity, ssh_keys
from scooter_broker_lib.authz import NoopAuthorizer
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.sources.user_first import UserFirstSource
from scooter_broker_lib.commit_identity import Person
from scooter_broker_lib.testing import assert_rows_match_schema_sql, create_schema, sqlite_config
from scooter_broker_lib.user_auth import ForgeAuthError, Profile, Tokens, UserAuth
from scooter_broker_lib.user_secrets import KeyRing, SecretBox
from scooter_contrib_github import user_auth
from scooter_contrib_github.broker_provider import github

ROOT = Path(__file__).resolve().parents[1]
KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample alice (scooter)"
OLD = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOld alice (scooter)"


class FakeGitHub:
    def __init__(self) -> None:
        self.keys = [{"id": 7, "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOld"}]
        self.calls: list[tuple[str, str, dict | None]] = []

    def handler(self, req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content) if req.content else None
        self.calls.append((req.method, req.url.path, body))
        auth = req.headers.get("authorization", "")
        if req.url.path == "/user":
            if auth != "Bearer good":
                return httpx.Response(401)
            return httpx.Response(200, json={"login": "alice-gh", "id": 42, "name": None})
        if req.url.path == "/user/keys" and req.method == "POST":
            return httpx.Response(201, json={"id": 8})
        if req.url.path == "/user/keys" and req.method == "GET":
            return httpx.Response(200, json=self.keys)
        if req.url.path.startswith("/user/keys/") and req.method == "DELETE":
            return httpx.Response(204)
        if req.url.path == "/app":
            return httpx.Response(200, json={"slug": "scooter-app"})
        if req.url.path == "/users/scooter-app[bot]":
            return httpx.Response(200, json={"id": 99})
        return httpx.Response(404)


@pytest.fixture
def gh() -> FakeGitHub:
    return FakeGitHub()


@pytest.fixture
def users(gh) -> user_auth.GitHubUsers:
    return user_auth.GitHubUsers(host="github.com", client_id="cid", client_secret="cs", transport=httpx.MockTransport(gh.handler))


def test_the_row_model_matches_schema_sql():
    assert_rows_match_schema_sql(user_auth.Base, ROOT / "sql" / "schema.sql")


@pytest.mark.parametrize(
    "host,email",
    [("github.com", "42+alice-gh@users.noreply.github.com"), ("ghe.example.com", "42+alice-gh@users.noreply.ghe.example.com")],
)
def test_the_noreply_email(host, email):
    assert user_auth.noreply_email(host, 42, "alice-gh") == email


async def test_the_profile_uses_the_login_when_there_is_no_name(users):
    profile = await users.profile("good")
    assert (profile.login, profile.name, profile.email) == ("alice-gh", "alice-gh", "42+alice-gh@users.noreply.github.com")


async def test_a_refused_token_is_a_forge_auth_error(users):
    with pytest.raises(ForgeAuthError):
        await users.profile("bad")


async def test_the_ssh_key_is_added_without_its_comment(users, gh):
    await users.add_ssh_key("good", KEY)
    assert gh.calls[-1] == ("POST", "/user/keys", {"title": "Scooter", "key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample"})


async def test_removing_deletes_only_the_matching_key(users, gh):
    await users.remove_ssh_key("good", OLD)
    assert ("DELETE", "/user/keys/7", None) in gh.calls
    gh.calls.clear()
    await users.remove_ssh_key("good", KEY)
    assert not any(m == "DELETE" for m, _, _ in gh.calls)


def test_the_oauth_endpoints_follow_the_host():
    f = user_auth.GitHubUsers(host="ghe.example.com", client_id="c", client_secret="s").forge("https://x/cb")
    assert f.authorize_url == "https://ghe.example.com/login/oauth/authorize"
    assert f.token_url == "https://ghe.example.com/login/oauth/access_token"
    assert f.scopes == ()


async def test_the_bot_is_the_app_slug(gh):
    class App:
        def _generate_jwt(self) -> str:
            return "jwt"

    bot = user_auth.GitHubBot(App(), "github.com", transport=httpx.MockTransport(gh.handler))  # type: ignore[arg-type]
    person = await bot.person()
    assert (person.name, person.email) == ("scooter-app[bot]", "99+scooter-app[bot]@users.noreply.github.com")
    await bot.person()
    assert sum(1 for _, p, _ in gh.calls if p == "/app") == 1


async def test_a_key_change_swaps_the_key_on_the_linked_account(users, gh):
    class Auth:
        async def access_token(self, user):
            return "good" if user == "alice" else None

    await user_auth.on_key_change(Auth(), users, ssh_keys.SshKeyChange(user="alice", new=KEY, old=OLD))  # type: ignore[arg-type]
    paths = [(m, p) for m, p, _ in gh.calls]
    assert ("DELETE", "/user/keys/7") in paths and ("POST", "/user/keys") in paths
    gh.calls.clear()
    await user_auth.on_key_change(Auth(), users, ssh_keys.SshKeyChange(user="bob", new=KEY))  # type: ignore[arg-type]
    assert gh.calls == []


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
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_deployment")
    monkeypatch.delenv("GITHUB_APP_ID", raising=False)


def test_user_auth_off_keeps_the_deployment_credential(token_env, monkeypatch):
    monkeypatch.setenv("GITHUB_USER_AUTH_ENABLED", "false")
    p = github(_ctx())
    assert not isinstance(p.credential, UserFirstSource)
    assert not any(isinstance(t, UserAuth) for t in p.transports)


def test_user_auth_on_acts_as_the_user_first(token_env, monkeypatch):
    monkeypatch.setenv("GITHUB_USER_AUTH_ENABLED", "true")
    monkeypatch.setenv("GITHUB_OAUTH_REDIRECT_URL", "https://scooter.test/contrib-api/github/callback")
    p = github(_ctx())
    assert isinstance(p.credential, UserFirstSource)
    # Mounted before the http-proxy, whose catch-all would otherwise take /user/*.
    assert isinstance(p.transports[0], UserAuth)


def test_user_auth_needs_the_broker_context(token_env, monkeypatch):
    monkeypatch.setenv("GITHUB_USER_AUTH_ENABLED", "true")
    assert not isinstance(github().credential, UserFirstSource)


async def test_the_commit_identity_names_a_linked_user(token_env, monkeypatch):
    monkeypatch.setenv("GITHUB_USER_AUTH_ENABLED", "true")
    auth = github(_ctx()).transports[0]
    await create_schema(auth, user_auth.Base)
    await auth._save("alice", "pat", Profile("alice-gh", "Alice", "42+alice-gh@users.noreply.github.com"), Tokens("x"))
    # A PAT deployment has no App, so no bot to credit.
    got = await commit_identity.resolve("alice")
    assert got == commit_identity.CommitIdentity(author=Person("Alice", "42+alice-gh@users.noreply.github.com"))
    assert await commit_identity.resolve("bob") == commit_identity.CommitIdentity(author=None)
