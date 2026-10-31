"""Linked forge accounts: the connect flow is bound to its user, tokens are sealed and refreshed once, and a refused refresh falls back."""

from __future__ import annotations

from urllib.parse import parse_qs, urlparse

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.orm import DeclarativeBase

from scooter_broker_lib.testing import create_schema, sqlite_config
from scooter_broker_lib.types import Credential, Identity, Provider
from scooter_broker_lib.user_auth import REFRESH_MARGIN_SECONDS, Forge, ForgeAuthError, Profile, UserAuth, user_token_table
from scooter_broker_lib.user_secrets import KeyRing, SecretBox


class Base(DeclarativeBase):
    pass


Table = user_token_table(Base, "test_user_tokens")


class FakeForge:
    """A token endpoint that issues numbered tokens and records grants."""

    def __init__(self) -> None:
        self.issued = 0
        self.requests: list[dict] = []
        self.refuse_refresh = False
        self.revoked: list[str] = []
        self.expires_in = 3600

    def handler(self, req: httpx.Request) -> httpx.Response:
        form = {k: v[0] for k, v in parse_qs(req.content.decode()).items()}
        self.requests.append(form)
        if form.get("grant_type") == "refresh_token" and self.refuse_refresh:
            return httpx.Response(200, json={"error": "bad_refresh_token"})
        if form.get("grant_type") == "authorization_code" and form.get("code") != "good-code":
            return httpx.Response(400, json={"error": "bad_verification_code"})
        self.issued += 1
        return httpx.Response(200, json={
            "access_token": f"access-{self.issued}",
            "expires_in": self.expires_in,
            "refresh_token": f"refresh-{self.issued}",
            "refresh_token_expires_in": 86400,
        })

    async def profile(self, token: str) -> Profile:
        if token == "bad-pat":
            raise ForgeAuthError("refused")
        return Profile(login="alice-gh", name="Alice", email="1+alice-gh@users.noreply.github.com")

    async def revoke(self, token: str) -> None:
        self.revoked.append(token)


class Clock:
    def __init__(self) -> None:
        self.t = 1_000_000.0

    def __call__(self) -> float:
        return self.t


@pytest.fixture
def fake() -> FakeForge:
    return FakeForge()


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
async def auth(fake, clock) -> UserAuth:
    forge = Forge(
        name="forge",
        label="Forge",
        authorize_url="https://forge.test/login/oauth/authorize",
        token_url="https://forge.test/login/oauth/access_token",
        client_id="cid",
        client_secret="csecret",
        redirect_uri="https://scooter.test/contrib-api/forge/callback",
        scopes=("api",),
        profile=fake.profile,
        credential=lambda t: Credential(kind="bearer", value=t),
        revoke=fake.revoke,
        transport=httpx.MockTransport(fake.handler),
    )
    a = UserAuth(forge=forge, table=Table, config=sqlite_config(), box=SecretBox.of(KeyRing.generate()), clock=clock)
    await create_schema(a, Base)
    return a


async def connect(auth: UserAuth, user: str = "alice") -> dict[str, str]:
    url = await auth.connect_url(user)
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


async def test_the_connect_url_uses_pkce_and_a_sealed_state(auth):
    q = await connect(auth)
    assert q["code_challenge_method"] == "S256" and q["code_challenge"]
    assert q["client_id"] == "cid" and q["scope"] == "api"
    assert q["redirect_uri"] == "https://scooter.test/contrib-api/forge/callback"
    assert "alice" not in q["state"]


async def test_completing_links_the_account_and_sends_the_verifier(auth, fake):
    q = await connect(auth)
    profile = await auth.complete("alice", "good-code", q["state"])
    assert profile.login == "alice-gh"
    assert fake.requests[-1]["code_verifier"]
    assert (await auth.credential("alice")).value == "access-1"


async def test_a_callback_opened_by_another_user_is_refused(auth):
    q = await connect(auth, "alice")
    with pytest.raises(Exception) as e:
        await auth.complete("mallory", "good-code", q["state"])
    assert getattr(e.value, "status_code", None) == 403
    assert await auth.account("mallory") is None


async def test_an_expired_state_is_refused(auth, clock):
    q = await connect(auth)
    clock.t += 11 * 60
    with pytest.raises(Exception) as e:
        await auth.complete("alice", "good-code", q["state"])
    assert getattr(e.value, "status_code", None) == 400


async def test_tokens_are_sealed_at_rest(auth):
    q = await connect(auth)
    await auth.complete("alice", "good-code", q["state"])
    async with auth._session() as s:
        row = await s.get(Table, "alice")
    assert row.access_token.startswith("v1.") and "access-1" not in row.access_token
    assert row.refresh_token.startswith("v1.") and "refresh-1" not in row.refresh_token


async def test_a_token_near_expiry_is_refreshed_and_the_new_refresh_token_kept(auth, fake, clock):
    q = await connect(auth)
    await auth.complete("alice", "good-code", q["state"])
    clock.t += 3600 - REFRESH_MARGIN_SECONDS + 1
    assert (await auth.credential("alice")).value == "access-2"
    assert fake.requests[-1] == {
        "client_id": "cid", "client_secret": "csecret", "grant_type": "refresh_token",
        "refresh_token": "refresh-1", "redirect_uri": "https://scooter.test/contrib-api/forge/callback",
    }
    clock.t += 3600 - REFRESH_MARGIN_SECONDS + 1
    assert (await auth.credential("alice")).value == "access-3"
    assert fake.requests[-1]["refresh_token"] == "refresh-2"


async def test_a_fresh_token_is_not_refreshed(auth, fake):
    q = await connect(auth)
    await auth.complete("alice", "good-code", q["state"])
    before = len(fake.requests)
    await auth.credential("alice")
    assert len(fake.requests) == before


async def test_a_refused_refresh_marks_the_link_broken(auth, fake, clock):
    q = await connect(auth)
    await auth.complete("alice", "good-code", q["state"])
    fake.refuse_refresh = True
    clock.t += 3600
    assert await auth.credential("alice") is None
    assert (await auth.account("alice")).broken is True
    assert await auth.profile("alice") is None


async def test_a_pat_never_expires(auth, clock):
    await auth.link_pat("alice", "pat-token")
    clock.t += 10 * 365 * 86400
    assert (await auth.credential("alice")).value == "pat-token"
    assert (await auth.account("alice")).kind == "pat"


async def test_a_refused_pat_is_not_linked(auth):
    with pytest.raises(Exception) as e:
        await auth.link_pat("alice", "bad-pat")
    assert getattr(e.value, "status_code", None) == 400
    assert await auth.account("alice") is None


async def test_unlinking_an_oauth_account_revokes_the_grant(auth, fake):
    q = await connect(auth)
    await auth.complete("alice", "good-code", q["state"])
    await auth.unlink("alice")
    assert await auth.account("alice") is None
    assert fake.revoked == ["access-1"]


async def test_unlinking_a_pat_revokes_nothing(auth, fake):
    await auth.link_pat("alice", "pat-token")
    await auth.unlink("alice")
    assert fake.revoked == []


async def test_on_linked_hooks_run_and_a_failure_keeps_the_link(auth):
    seen = []

    async def ok(user, token):
        seen.append((user, token))

    async def broken(user, token):
        raise RuntimeError("forge down")

    auth.on_linked += [broken, ok]
    await auth.link_pat("alice", "pat-token")
    assert seen == [("alice", "pat-token")]
    assert await auth.account("alice") is not None


# -- routes --------------------------------------------------------------------


@pytest.fixture
def app(auth) -> FastAPI:
    caller: dict[str, Identity] = {}

    async def authed() -> Identity:
        return caller["identity"]

    a = FastAPI()
    a.include_router(auth.routes(Provider(name="forge", transports=[auth]), authed), prefix="/forge")
    a.state.caller = caller
    return a


def client(app, user: str | None) -> AsyncClient:
    app.state.caller["identity"] = Identity(conversation_id="", namespace="ns", service_account="sa", relayed_user=user)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://broker")


async def test_routes_need_the_relay(app):
    async with client(app, None) as c:
        for method, path in [("GET", "account"), ("POST", "connect"), ("GET", "callback"), ("DELETE", "account")]:
            assert (await c.request(method, f"/forge/user/{path}")).status_code == 403


async def test_the_route_flow_links_and_unlinks(app, auth):
    async with client(app, "alice") as c:
        assert (await c.get("/forge/user/account")).json() == {"connected": False, "oauth": True}
        url = (await c.post("/forge/user/connect")).json()["url"]
        state = parse_qs(urlparse(url).query)["state"][0]
        page = await c.get("/forge/user/callback", params={"code": "good-code", "state": state})
        assert page.status_code == 200 and "alice-gh" in page.text and "/settings/forge" in page.text
        account = (await c.get("/forge/user/account")).json()
        assert account["connected"] and account["login"] == "alice-gh" and account["kind"] == "oauth"
        assert (await c.delete("/forge/user/account")).json() == {"connected": False, "oauth": True}


async def test_a_denied_authorization_shows_the_reason(app):
    async with client(app, "alice") as c:
        page = await c.get("/forge/user/callback", params={"error": "access_denied"})
    assert "access_denied" in page.text and "not linked" in page.text


async def test_the_callback_page_escapes_forge_text(app):
    async with client(app, "alice") as c:
        page = await c.get("/forge/user/callback", params={"error": "<script>x</script>"})
    assert "<script>x" not in page.text


async def test_the_pat_route_links(app):
    async with client(app, "alice") as c:
        body = (await c.post("/forge/user/pat", json={"token": "pat-token"})).json()
        assert body["kind"] == "pat" and body["login"] == "alice-gh"
        assert (await c.post("/forge/user/pat", json={"token": ""})).status_code == 400


async def test_connect_is_404_without_oauth_configured(app, auth):
    auth.forge.client_secret = ""
    async with client(app, "alice") as c:
        assert (await c.post("/forge/user/connect")).status_code == 404
        assert (await c.get("/forge/user/account")).json()["oauth"] is False

