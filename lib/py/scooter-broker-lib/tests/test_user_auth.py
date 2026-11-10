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
from scooter_broker_lib.user_secrets import KeyRing, SecretBox, _mint



def g(user: str):
    return _mint(user, "settings-session")

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
        self.external_id = "1"
        self.profiles = 0

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
        self.profiles += 1
        if token == "bad-pat":
            raise ForgeAuthError("refused")
        return Profile(login="alice-gh", name="Alice", email="1+alice-gh@users.noreply.github.com", external_id=self.external_id)

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
    url = await auth.connect_url(g(user))
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


async def test_the_connect_url_uses_pkce_and_a_sealed_state(auth):
    q = await connect(auth)
    assert q["code_challenge_method"] == "S256" and q["code_challenge"]
    assert q["client_id"] == "cid" and q["scope"] == "api"
    assert q["redirect_uri"] == "https://scooter.test/contrib-api/forge/callback"
    assert "alice" not in q["state"]


async def test_completing_links_the_account_and_sends_the_verifier(auth, fake):
    q = await connect(auth)
    profile = await auth.complete(g("alice"), "good-code", q["state"])
    assert profile.login == "alice-gh"
    assert fake.requests[-1]["code_verifier"]
    assert (await auth.credential(g("alice"))).value == "access-1"


async def test_a_callback_opened_by_another_user_is_refused(auth):
    q = await connect(auth, "alice")
    with pytest.raises(Exception) as e:
        await auth.complete(g("mallory"), "good-code", q["state"])
    assert getattr(e.value, "status_code", None) == 400
    assert await auth.account("mallory") is None


async def test_an_expired_state_is_refused(auth, clock):
    q = await connect(auth)
    clock.t += 11 * 60
    with pytest.raises(Exception) as e:
        await auth.complete(g("alice"), "good-code", q["state"])
    assert getattr(e.value, "status_code", None) == 400


async def test_tokens_are_sealed_at_rest(auth):
    q = await connect(auth)
    await auth.complete(g("alice"), "good-code", q["state"])
    async with auth._session() as s:
        row = await s.get(Table, "alice")
    assert row.access_token.startswith("v1.") and "access-1" not in row.access_token
    assert row.refresh_token.startswith("v1.") and "refresh-1" not in row.refresh_token


async def test_a_token_near_expiry_is_refreshed_and_the_new_refresh_token_kept(auth, fake, clock):
    q = await connect(auth)
    await auth.complete(g("alice"), "good-code", q["state"])
    clock.t += 3600 - REFRESH_MARGIN_SECONDS + 1
    assert (await auth.credential(g("alice"))).value == "access-2"
    assert fake.requests[-1] == {
        "client_id": "cid", "client_secret": "csecret", "grant_type": "refresh_token",
        "refresh_token": "refresh-1", "redirect_uri": "https://scooter.test/contrib-api/forge/callback",
    }
    clock.t += 3600 - REFRESH_MARGIN_SECONDS + 1
    assert (await auth.credential(g("alice"))).value == "access-3"
    assert fake.requests[-1]["refresh_token"] == "refresh-2"


async def test_a_fresh_token_is_not_refreshed(auth, fake):
    q = await connect(auth)
    await auth.complete(g("alice"), "good-code", q["state"])
    before = len(fake.requests)
    await auth.credential(g("alice"))
    assert len(fake.requests) == before


async def test_a_refused_refresh_marks_the_link_broken(auth, fake, clock):
    q = await connect(auth)
    await auth.complete(g("alice"), "good-code", q["state"])
    fake.refuse_refresh = True
    clock.t += 3600
    assert await auth.credential(g("alice")) is None
    assert (await auth.account("alice")).broken is True
    assert await auth.profile("alice") is None


async def test_a_pat_never_expires(auth, clock):
    await auth.link_pat(g("alice"), "pat-token")
    clock.t += 10 * 365 * 86400
    assert (await auth.credential(g("alice"))).value == "pat-token"
    assert (await auth.account("alice")).kind == "pat"


async def test_a_refused_pat_is_not_linked(auth):
    with pytest.raises(Exception) as e:
        await auth.link_pat(g("alice"), "bad-pat")
    assert getattr(e.value, "status_code", None) == 400
    assert await auth.account("alice") is None


async def test_unlinking_an_oauth_account_revokes_the_grant(auth, fake):
    q = await connect(auth)
    await auth.complete(g("alice"), "good-code", q["state"])
    await auth.unlink(g("alice"))
    assert await auth.account("alice") is None
    assert fake.revoked == ["access-1"]


async def test_unlinking_a_pat_revokes_nothing(auth, fake):
    await auth.link_pat(g("alice"), "pat-token")
    await auth.unlink(g("alice"))
    assert fake.revoked == []


async def test_on_linked_hooks_run_and_a_failure_keeps_the_link(auth):
    seen = []

    async def ok(grant, token):
        seen.append((grant.user, token))

    async def broken(user, token):
        raise RuntimeError("forge down")

    auth.on_linked += [broken, ok]
    await auth.link_pat(g("alice"), "pat-token")
    assert seen == [("alice", "pat-token")]
    assert await auth.account("alice") is not None


# -- identity links --------------------------------------------------------------


class FakeLinks:
    """The agent-host's identity links, in memory."""

    def __init__(self) -> None:
        self.linked: dict[tuple[str, str], tuple[str, str]] = {}
        self.calls = 0
        self.fail = False

    def _maybe_fail(self) -> None:
        self.calls += 1
        if self.fail:
            raise httpx.ConnectError("agent-host down")

    async def link(self, provider: str, user: str, external_id: str, handle: str) -> None:
        self._maybe_fail()
        self.linked[(provider, user)] = (external_id, handle)

    async def unlink(self, provider: str, user: str) -> None:
        self._maybe_fail()
        self.linked.pop((provider, user), None)


@pytest.fixture
def links(auth) -> FakeLinks:
    auth.identity_links = FakeLinks()
    return auth.identity_links


async def test_linking_records_the_account_as_the_user(auth, links):
    await auth.link_pat(g("alice"), "pat-token")
    assert links.linked == {("forge", "alice"): ("1", "alice-gh")}


async def test_completing_oauth_records_the_account_as_the_user(auth, links):
    q = await connect(auth)
    await auth.complete(g("alice"), "good-code", q["state"])
    assert links.linked == {("forge", "alice"): ("1", "alice-gh")}


async def test_unlinking_clears_the_identity_link(auth, links):
    await auth.link_pat(g("alice"), "pat-token")
    await auth.unlink(g("alice"))
    assert links.linked == {}
    assert await auth.account("alice") is None


async def test_an_unlink_the_agent_host_refuses_keeps_the_account(auth, links):
    await auth.link_pat(g("alice"), "pat-token")
    links.fail = True
    with pytest.raises(Exception) as e:
        await auth.unlink(g("alice"))
    assert getattr(e.value, "status_code", None) == 502
    assert await auth.account("alice") is not None


async def test_an_account_linked_before_ids_were_kept_is_backfilled_on_use(auth, fake, links):
    auth.identity_links = None
    fake.external_id = ""
    await auth.link_pat(g("alice"), "pat-token")
    auth.identity_links, fake.external_id, fake.profiles = links, "1", 0

    assert (await auth.credential(g("alice"))).value == "pat-token"
    assert links.linked == {("forge", "alice"): ("1", "alice-gh")}
    # The id is stored, and the link written once per replica.
    await auth.credential(g("alice"))
    assert fake.profiles == 1 and links.calls == 1


async def test_a_failed_link_is_retried_on_the_next_use(auth, links):
    links.fail = True
    await auth.link_pat(g("alice"), "pat-token")
    assert await auth.account("alice") is not None
    links.fail = False
    await auth.credential(g("alice"))
    assert links.linked == {("forge", "alice"): ("1", "alice-gh")}


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

