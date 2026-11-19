"""apikeys's HTTP routes, mounted under /apikeys/*.

    GET    /user/keys            the caller's keys, without secrets
    POST   /user/keys            {name, scopes?, expires_in_days?}: a new key, shown once
    DELETE /user/keys/{key_id}   revoke one
    POST   /verify               {key, ip?}: the key's user and scopes, for webhooks

/user/* is reached only through the /contrib-api relay, as the signed-in user.
/verify answers only the ServiceAccounts in APIKEYS_VERIFIER_SERVICE_ACCOUNTS,
proven with TokenReview; it never takes the core's sandbox identity.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass

from fastapi import APIRouter, Body, Depends, HTTPException, Request

from scooter_broker_lib.types import AuthDependency, Provider
from scooter_broker_lib.user import user_identity
from scooter_lib.svcauth import AuthError, Principal

from .store import DEFAULT_TTL_DAYS, MAX_KEYS_PER_USER, MAX_TTL_DAYS, SCOPES, ApiKeyStore, TooManyKeys

logger = logging.getLogger(__name__)

_MAX_NAME = 64
# Far longer than any real key.
_MAX_KEY = 256

# Proves a caller from headers; raises AuthError otherwise.
CallerCheck = Callable[[Mapping[str, str]], Awaitable[Principal]]


def _scopes(raw: object) -> tuple[str, ...]:
    if raw is None:
        return SCOPES
    if not isinstance(raw, list) or not raw or any(s not in SCOPES for s in raw):
        raise HTTPException(status_code=400, detail=f"scopes must be a non-empty subset of {list(SCOPES)}")
    return tuple(raw)


def _ttl(raw: object) -> int:
    if raw is None:
        return DEFAULT_TTL_DAYS
    if isinstance(raw, bool) or not isinstance(raw, int) or not 1 <= raw <= MAX_TTL_DAYS:
        raise HTTPException(status_code=400, detail=f"expires_in_days must be 1 to {MAX_TTL_DAYS}")
    return raw


@dataclass
class ApiKeys:
    store: ApiKeyStore | None = None
    verifier: CallerCheck | None = None
    name: str = "apikeys"

    def _store(self) -> ApiKeyStore:
        if self.store is None:
            raise HTTPException(status_code=503, detail="apikeys is not configured")
        return self.store

    async def _require_verifier(self, request: Request) -> Principal:
        if self.verifier is None:
            raise HTTPException(status_code=503, detail="apikeys verification is not configured")
        try:
            return await self.verifier(request.headers)
        except AuthError as exc:
            raise HTTPException(status_code=exc.status, detail="caller may not verify keys") from None

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        user_dep = user_identity(authed)

        @router.get("/user/keys")
        async def list_keys(user: str = Depends(user_dep)) -> dict:
            infos = await self._store().list(user)
            return {"keys": [k.payload() for k in infos], "limit": MAX_KEYS_PER_USER, "max_days": MAX_TTL_DAYS}

        @router.post("/user/keys")
        async def create_key(body: dict = Body(...), user: str = Depends(user_dep)) -> dict:
            name = body.get("name")
            if not isinstance(name, str) or not name.strip() or len(name) > _MAX_NAME:
                raise HTTPException(status_code=400, detail=f"name must be 1 to {_MAX_NAME} characters")
            try:
                info, plaintext = await self._store().create(
                    user, name.strip(), _scopes(body.get("scopes")), _ttl(body.get("expires_in_days")))
            except TooManyKeys:
                raise HTTPException(status_code=409, detail=f"at most {MAX_KEYS_PER_USER} keys; revoke one first") from None
            logger.info("api key created", extra={"user": user, "key_id": info.key_id, "scopes": list(info.scopes)})
            return {**info.payload(), "key": plaintext}

        @router.delete("/user/keys/{key_id}")
        async def revoke_key(key_id: str, user: str = Depends(user_dep)) -> dict:
            if not await self._store().revoke(user, key_id):
                raise HTTPException(status_code=404, detail="no such key")
            logger.info("api key revoked", extra={"user": user, "key_id": key_id})
            return {"revoked": key_id}

        @router.post("/verify")
        async def verify(request: Request, body: dict = Body(...)) -> dict:
            caller = await self._require_verifier(request)
            key, ip = body.get("key"), body.get("ip")
            if not isinstance(key, str) or len(key) > _MAX_KEY or (ip is not None and not isinstance(ip, str)):
                raise HTTPException(status_code=400, detail="key must be a string")
            found = await self._store().verify(key, ip)
            if found is None:
                logger.info("api key refused", extra={"verifier": caller.service_account})
                raise HTTPException(status_code=401, detail="invalid key")
            return {"user": found.user, "key_id": found.key_id, "scopes": list(found.scopes), "expires_at": found.expires_at}

        return router
