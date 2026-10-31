"""Encryption at rest for the per-user secrets a contrib stores: tokens, private keys.

Each value is sealed with AES-256-GCM under the keyring's current key and bound to a
caller-chosen context (for example ``"github:<user>"``), so a ciphertext copied into
another user's row fails to open. A sealed value names its key, so old rows stay
readable after a new key becomes current.

The broker supplies the keyring (from a Secret only it reads) through
``BrokerContext.user_secrets``; a contrib never builds one itself.
"""

from __future__ import annotations

import asyncio
import base64
import os
import re
from dataclasses import dataclass
from typing import Awaitable, Callable

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_VERSION = "v1"
_KEY_ID = re.compile(r"^[a-z0-9]{1,32}$")
_NONCE_BYTES = 12


class SecretError(Exception):
    """A sealed value could not be opened: unknown key, tampering, or the wrong context."""


@dataclass(frozen=True)
class KeyRing:
    """Named 256-bit keys and the one that seals new values."""

    keys: dict[str, bytes]
    current: str

    def __post_init__(self) -> None:
        if self.current not in self.keys:
            raise ValueError(f"current key {self.current!r} is not in the keyring")
        for kid, key in self.keys.items():
            if not _KEY_ID.match(kid):
                raise ValueError(f"key id {kid!r} must match {_KEY_ID.pattern}")
            if len(key) != 32:
                raise ValueError(f"key {kid!r} must be 32 bytes")

    @staticmethod
    def generate(kid: str = "k1") -> "KeyRing":
        return KeyRing(keys={kid: os.urandom(32)}, current=kid)


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def seal(ring: KeyRing, plaintext: str, context: str) -> str:
    """`plaintext` encrypted under the current key, as ``v1.<key id>.<nonce+ciphertext>``."""
    nonce = os.urandom(_NONCE_BYTES)
    ct = AESGCM(ring.keys[ring.current]).encrypt(nonce, plaintext.encode(), context.encode())
    return f"{_VERSION}.{ring.current}.{_b64e(nonce + ct)}"


def open_sealed(ring: KeyRing, sealed: str, context: str) -> str:
    """The plaintext of a `seal` result made with the same `context`, or SecretError."""
    try:
        version, kid, body = sealed.split(".", 2)
    except ValueError:
        raise SecretError("not a sealed value") from None
    if version != _VERSION:
        raise SecretError(f"unsupported sealed-value version {version!r}")
    key = ring.keys.get(kid)
    if key is None:
        raise SecretError(f"sealed with unknown key {kid!r}")
    try:
        raw = _b64d(body)
        return AESGCM(key).decrypt(raw[:_NONCE_BYTES], raw[_NONCE_BYTES:], context.encode()).decode()
    except (InvalidTag, ValueError) as e:
        raise SecretError("sealed value failed authentication") from e


class SecretBox:
    """Seals and opens per-user secrets, loading the keyring once on first use."""

    def __init__(self, load: Callable[[], Awaitable[KeyRing]]):
        self._load = load
        self._ring: KeyRing | None = None
        self._lock = asyncio.Lock()

    @staticmethod
    def of(ring: KeyRing) -> "SecretBox":
        """A box over a fixed keyring, for tests and local runs."""

        async def load() -> KeyRing:
            return ring

        return SecretBox(load)

    async def ring(self) -> KeyRing:
        if self._ring is None:
            async with self._lock:
                if self._ring is None:
                    self._ring = await self._load()
        return self._ring

    async def seal(self, plaintext: str, context: str) -> str:
        return seal(await self.ring(), plaintext, context)

    async def open(self, sealed: str, context: str) -> str:
        return open_sealed(await self.ring(), sealed, context)
