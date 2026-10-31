"""ssh's HTTP routes, mounted under /ssh/*.

    GET  /user/key       the caller's public key, created on first visit
    POST /user/rotate    replace it with a fresh key
    GET  /identities     the keys a sandbox's ssh-agent offers
    POST /sign           {key, data, flags, host_key?}: an agent signature

/user/* is reached only through the /contrib-api relay. /identities and /sign
serve sandboxes, and offer the key only in its owner's private conversation
(OwnerResolver.acting_user); everywhere else the agent has no identity.
"""

from __future__ import annotations

import base64
import binascii
import logging
from dataclasses import dataclass

from fastapi import APIRouter, Body, Depends, HTTPException

from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.ssh_keys import SshKeyChange, announce
from scooter_broker_lib.types import AuthDependency, Identity, Provider
from scooter_broker_lib.user import user_identity

from .keys import fingerprint
from .store import SshKeyStore

logger = logging.getLogger(__name__)

# Far above any real SSH auth or SSHSIG payload.
_MAX_SIGN_BYTES = 64 * 1024


def _b64(body: dict, name: str, *, required: bool = True) -> bytes | None:
    raw = body.get(name)
    if raw is None and not required:
        return None
    if not isinstance(raw, str):
        raise HTTPException(status_code=400, detail=f"{name} must be base64")
    try:
        return base64.b64decode(raw, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=400, detail=f"{name} must be base64") from None


@dataclass
class SshKey:
    store: SshKeyStore | None = None
    owners: OwnerResolver | None = None
    name: str = "ssh"

    def _ready(self) -> tuple[SshKeyStore, OwnerResolver]:
        if self.store is None or self.owners is None:
            raise HTTPException(status_code=503, detail="ssh is not configured")
        return self.store, self.owners

    async def _acting(self, identity: Identity):
        store, owners = self._ready()
        user = await owners.acting_user(identity)
        return (user, await store.get(user)) if user else (None, None)

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()
        user_dep = user_identity(authed)

        @router.get("/user/key")
        async def get_key(user: str = Depends(user_dep)) -> dict:
            store, _ = self._ready()
            key, created = await store.get_or_create(user)
            if created:
                await announce(SshKeyChange(user=user, new=key.public_key))
            return key.payload()

        @router.post("/user/rotate")
        async def rotate(user: str = Depends(user_dep)) -> dict:
            store, _ = self._ready()
            old, new = await store.rotate(user)
            logger.info("ssh key rotated", extra={"user": user, "fingerprint": new.fingerprint})
            await announce(SshKeyChange(user=user, new=new.public_key, old=old.public_key if old else None))
            return new.payload()

        @router.get("/identities")
        async def identities(identity: Identity = Depends(authed)) -> dict:
            _, key = await self._acting(identity)
            if key is None:
                return {"identities": []}
            return {"identities": [{"key": base64.b64encode(key.pair.blob).decode(), "comment": key.public_key.split(" ", 2)[-1]}]}

        @router.post("/sign")
        async def sign(body: dict = Body(...), identity: Identity = Depends(authed)) -> dict:
            blob = _b64(body, "key")
            data = _b64(body, "data")
            host_key = _b64(body, "host_key", required=False)
            assert blob is not None and data is not None
            if len(data) > _MAX_SIGN_BYTES:
                raise HTTPException(status_code=400, detail="data is too large")
            user, key = await self._acting(identity)
            if key is None or key.pair.blob != blob:
                raise HTTPException(status_code=403, detail="no such key for this conversation")
            logger.info(
                "ssh signature",
                extra={
                    "conversation_id": identity.conversation_id,
                    "user": user,
                    "fingerprint": key.fingerprint,
                    "host_key": fingerprint(host_key) if host_key else None,
                },
            )
            return {"signature": base64.b64encode(key.pair.sign(data)).decode()}

        return router
