"""Per-user forge accounts: an OAuth connect flow (or a pasted PAT), sealed token storage, and refresh.

A forge contrib supplies a `Forge` (its URLs and how to read a profile) and a
table built by `user_token_table`; `UserAuth` adds the settings-tab routes and
`credential(user)`, which a `UserFirstSource` calls for the forge proxy, the
http-proxy and the agent tools.

    GET    /user/account    the linked account, or {"connected": false}
    POST   /user/connect    {"url"}: where the tab sends the browser to authorize
    GET    /user/callback   the forge's redirect back; answers HTML that returns to Settings
    POST   /user/pat        {"token"}: link a personal access token instead
    DELETE /user/account    unlink, revoking the grant where the forge allows it

The connect state is sealed with the user it was issued to, so a callback opened
by anyone else (a forged link) is refused.
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from sqlalchemy import BigInteger, Boolean, String, Text, select
from sqlalchemy.orm import Mapped, mapped_column

from scooter_lib.logging_config import format_error

from .store import StoreConfig, open_sessions
from .types import AuthDependency, Credential, Provider
from .user import user_identity
from .user_secrets import SecretBox, SecretError

logger = logging.getLogger(__name__)

# Refresh this long before expiry, so a token never expires mid-request.
REFRESH_MARGIN_SECONDS = 5 * 60
_STATE_TTL_SECONDS = 10 * 60


@dataclass(frozen=True)
class Profile:
    """The forge account a token belongs to."""

    login: str
    name: str
    email: str


@dataclass(frozen=True)
class Tokens:
    access_token: str
    expires_at: int | None = None
    refresh_token: str | None = None
    refresh_expires_at: int | None = None


class ForgeAuthError(Exception):
    """The forge refused a code, refresh token or PAT."""


@dataclass
class Forge:
    """One forge's OAuth endpoints and account lookup."""

    name: str                          # "github" | "gitlab": the contrib and route prefix
    label: str                         # "GitHub"
    authorize_url: str
    token_url: str
    client_id: str
    client_secret: str
    redirect_uri: str
    scopes: tuple[str, ...]
    profile: Callable[[str], Awaitable[Profile]]
    # The credential to put on requests for a token, e.g. bearer or PRIVATE-TOKEN.
    credential: Callable[[str], Credential]
    revoke: Callable[[str], Awaitable[None]] | None = None
    transport: httpx.AsyncBaseTransport | None = None

    @property
    def oauth_enabled(self) -> bool:
        return bool(self.client_id and self.client_secret and self.redirect_uri)

    async def _token_request(self, data: dict[str, str], now: float) -> Tokens:
        async with httpx.AsyncClient(timeout=15, transport=self.transport) as client:
            resp = await client.post(
                self.token_url,
                data={"client_id": self.client_id, "client_secret": self.client_secret, **data},
                headers={"Accept": "application/json"},
            )
        body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
        # GitHub answers 200 with an "error" field.
        if resp.status_code >= 400 or "access_token" not in body:
            raise ForgeAuthError(body.get("error_description") or body.get("error") or f"HTTP {resp.status_code}")
        def at(key: str) -> int | None:
            return int(now) + int(body[key]) if body.get(key) else None

        return Tokens(
            access_token=body["access_token"],
            expires_at=at("expires_in"),
            refresh_token=body.get("refresh_token") or None,
            refresh_expires_at=at("refresh_token_expires_in"),
        )

    async def exchange(self, code: str, verifier: str, now: float) -> Tokens:
        return await self._token_request({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
            "code_verifier": verifier,
        }, now)

    async def refresh(self, refresh_token: str, now: float) -> Tokens:
        return await self._token_request({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "redirect_uri": self.redirect_uri,
        }, now)


def user_token_table(base: type, tablename: str) -> type:
    """The row model for one forge's linked accounts, on the contrib's own declarative `base`."""

    class UserToken(base):  # type: ignore[valid-type, misc]
        __tablename__ = tablename

        user_id: Mapped[str] = mapped_column(String, primary_key=True)
        kind: Mapped[str] = mapped_column(String)            # "oauth" | "pat"
        login: Mapped[str] = mapped_column(String)
        name: Mapped[str] = mapped_column(String)
        email: Mapped[str] = mapped_column(String)
        access_token: Mapped[str] = mapped_column(Text)      # sealed
        access_expires_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
        refresh_token: Mapped[str | None] = mapped_column(Text, nullable=True)  # sealed
        refresh_expires_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
        # Set when a refresh is refused; the tab then asks the user to reconnect.
        broken: Mapped[bool] = mapped_column(Boolean, default=False)
        updated_at: Mapped[int] = mapped_column(BigInteger)

    UserToken.__name__ = UserToken.__qualname__ = f"UserToken_{tablename}"
    return UserToken


@dataclass(frozen=True)
class Account:
    kind: str
    profile: Profile
    broken: bool

    def payload(self) -> dict:
        return {
            "connected": True,
            "kind": self.kind,
            "login": self.profile.login,
            "name": self.profile.name,
            "email": self.profile.email,
            "broken": self.broken,
        }


@dataclass
class UserAuth:
    """Linked accounts for one forge: storage, refresh and the settings-tab routes."""

    forge: Forge
    table: type
    config: StoreConfig
    box: SecretBox
    clock: Callable[[], float] = time.time
    # Called with (user, access token) after a successful link, e.g. to register an SSH key.
    on_linked: list[Callable[[str, str], Awaitable[None]]] = field(default_factory=list)
    name: str = "user-auth"

    def __post_init__(self) -> None:
        self._engine, self._session = open_sessions(self.config)

    # -- storage --------------------------------------------------------------

    def _ctx(self, user: str, what: str) -> str:
        return f"{self.forge.name}:{what}:{user}"

    async def _save(self, user: str, kind: str, profile: Profile, tokens: Tokens) -> None:
        row = self.table(
            user_id=user,
            kind=kind,
            login=profile.login,
            name=profile.name,
            email=profile.email,
            access_token=await self.box.seal(tokens.access_token, self._ctx(user, "access")),
            access_expires_at=tokens.expires_at,
            refresh_token=(
                await self.box.seal(tokens.refresh_token, self._ctx(user, "refresh")) if tokens.refresh_token else None
            ),
            refresh_expires_at=tokens.refresh_expires_at,
            broken=False,
            updated_at=int(self.clock()),
        )
        async with self._session() as s, s.begin():
            await s.merge(row)

    async def account(self, user: str) -> Account | None:
        async with self._session() as s:
            row = await s.get(self.table, user)
        if row is None:
            return None
        return Account(kind=row.kind, profile=Profile(row.login, row.name, row.email), broken=row.broken)

    async def access_token(self, user: str) -> str | None:
        """A usable access token for `user`, refreshed if it is about to expire; None when unlinked or broken."""
        async with self._session() as s:
            row = await s.get(self.table, user)
            if row is None or row.broken:
                return None
            if row.access_expires_at is None or row.access_expires_at - REFRESH_MARGIN_SECONDS > self.clock():
                return await self.box.open(row.access_token, self._ctx(user, "access"))
        return await self._refresh(user)

    async def _refresh(self, user: str) -> str | None:
        # The row lock makes one replica spend the single-use refresh token; others wait, then reuse.
        async with self._session() as s, s.begin():
            row = (await s.execute(select(self.table).where(self.table.user_id == user).with_for_update())).scalar_one_or_none()
            if row is None or row.broken:
                return None
            if row.access_expires_at is not None and row.access_expires_at - REFRESH_MARGIN_SECONDS > self.clock():
                return await self.box.open(row.access_token, self._ctx(user, "access"))
            try:
                if row.refresh_token is None:
                    raise ForgeAuthError("expired, and no refresh token")
                tokens = await self.forge.refresh(
                    await self.box.open(row.refresh_token, self._ctx(user, "refresh")), self.clock()
                )
            except (ForgeAuthError, SecretError) as e:
                logger.warning(
                    "user token refresh refused; the user must reconnect",
                    extra={"forge": self.forge.name, "user": user, "error": format_error(e)},
                )
                row.broken = True
                return None
            row.access_token = await self.box.seal(tokens.access_token, self._ctx(user, "access"))
            row.access_expires_at = tokens.expires_at
            if tokens.refresh_token:
                row.refresh_token = await self.box.seal(tokens.refresh_token, self._ctx(user, "refresh"))
                row.refresh_expires_at = tokens.refresh_expires_at
            row.updated_at = int(self.clock())
            return tokens.access_token

    async def credential(self, user: str) -> Credential | None:
        token = await self.access_token(user)
        return self.forge.credential(token) if token else None

    async def profile(self, user: str) -> Profile | None:
        """The linked account's profile while it is usable."""
        account = await self.account(user)
        return account.profile if account and not account.broken else None

    async def unlink(self, user: str) -> None:
        token = None
        try:
            token = await self.access_token(user)
        except (SecretError, httpx.HTTPError):
            pass
        async with self._session() as s, s.begin():
            row = await s.get(self.table, user)
            kind = row.kind if row else None
            if row is not None:
                await s.delete(row)
        if token and kind == "oauth" and self.forge.revoke is not None:
            try:
                await self.forge.revoke(token)
            except httpx.HTTPError as e:
                logger.warning("grant revoke failed", extra={"forge": self.forge.name, "error": format_error(e)})

    async def _linked(self, user: str, token: str) -> None:
        for hook in self.on_linked:
            try:
                await hook(user, token)
            except Exception as e:  # noqa: BLE001 - a hook failing must not undo the link
                logger.warning("on_linked hook failed", extra={"forge": self.forge.name, "error": format_error(e)})

    # -- the connect flow ---------------------------------------------------------

    async def connect_url(self, user: str) -> str:
        verifier = base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = await self.box.seal(
            json.dumps({"u": user, "v": verifier, "exp": int(self.clock()) + _STATE_TTL_SECONDS}),
            f"{self.forge.name}:oauth-state",
        )
        query = {
            "client_id": self.forge.client_id,
            "redirect_uri": self.forge.redirect_uri,
            "response_type": "code",
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
        if self.forge.scopes:
            query["scope"] = " ".join(self.forge.scopes)
        return f"{self.forge.authorize_url}?{urlencode(query)}"

    async def complete(self, user: str, code: str, state: str) -> Profile:
        try:
            claims = json.loads(await self.box.open(state, f"{self.forge.name}:oauth-state"))
        except (SecretError, ValueError):
            raise HTTPException(status_code=400, detail="invalid state") from None
        if claims.get("u") != user:
            raise HTTPException(status_code=403, detail="this link was started by another user")
        if int(claims.get("exp", 0)) < self.clock():
            raise HTTPException(status_code=400, detail="the link expired; start again from Settings")
        try:
            tokens = await self.forge.exchange(code, claims["v"], self.clock())
            profile = await self.forge.profile(tokens.access_token)
        except (ForgeAuthError, httpx.HTTPError) as e:
            raise HTTPException(status_code=502, detail=f"{self.forge.label} refused the link: {e}") from e
        await self._save(user, "oauth", profile, tokens)
        await self._linked(user, tokens.access_token)
        return profile

    async def link_pat(self, user: str, token: str) -> Profile:
        try:
            profile = await self.forge.profile(token)
        except (ForgeAuthError, httpx.HTTPError) as e:
            raise HTTPException(status_code=400, detail=f"{self.forge.label} refused the token: {e}") from e
        await self._save(user, "pat", profile, Tokens(access_token=token))
        await self._linked(user, token)
        return profile

    # -- routes ---------------------------------------------------------------------

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        user_dep = user_identity(authed)

        @router.get("/user/account")
        async def get_account(user: str = Depends(user_dep)) -> dict:
            account = await self.account(user)
            base = account.payload() if account else {"connected": False}
            return {**base, "oauth": self.forge.oauth_enabled}

        @router.post("/user/connect")
        async def connect(user: str = Depends(user_dep)) -> dict:
            if not self.forge.oauth_enabled:
                raise HTTPException(status_code=404, detail=f"{self.forge.label} sign-in is not configured")
            return {"url": await self.connect_url(user)}

        @router.get("/user/callback", response_class=HTMLResponse)
        async def callback(
            user: str = Depends(user_dep),
            code: str = Query(""),
            state: str = Query(""),
            error: str = Query(""),
        ) -> HTMLResponse:
            if error or not code:
                return _page(f"{self.forge.label} was not linked: {error or 'no code returned'}.", self.forge.name, ok=False)
            try:
                profile = await self.complete(user, code, state)
            except HTTPException as e:
                return _page(f"{self.forge.label} was not linked: {e.detail}", self.forge.name, ok=False, status=e.status_code)
            return _page(f"Linked {self.forge.label} account {profile.login}.", self.forge.name, ok=True)

        @router.post("/user/pat")
        async def pat(body: dict = Body(...), user: str = Depends(user_dep)) -> dict:
            token = body.get("token")
            if not isinstance(token, str) or not token.strip():
                raise HTTPException(status_code=400, detail="token is required")
            await self.link_pat(user, token.strip())
            account = await self.account(user)
            assert account is not None
            return {**account.payload(), "oauth": self.forge.oauth_enabled}

        @router.delete("/user/account")
        async def unlink(user: str = Depends(user_dep)) -> dict:
            await self.unlink(user)
            return {"connected": False, "oauth": self.forge.oauth_enabled}

        return router


def _page(message: str, tab: str, *, ok: bool, status: int = 200) -> HTMLResponse:
    """A minimal page that returns the browser to the forge's Settings tab."""
    target = f"/settings/{tab}"
    body = (
        "<!doctype html><meta charset=utf-8>"
        f"<meta http-equiv=refresh content='{2 if ok else 8};url={target}'>"
        f"<title>{'Linked' if ok else 'Not linked'}</title>"
        f"<p>{html.escape(message)}</p><p><a href='{target}'>Back to Settings</a></p>"
    )
    return HTMLResponse(body, status_code=status)
