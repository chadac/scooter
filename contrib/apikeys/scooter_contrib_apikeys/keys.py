"""The key format, `sct_<key_id>_<secret>`, and the stored digest of its secret.

The secret is 256 bits from the OS CSPRNG, so a plain SHA-256 digest is enough
to store it: there is nothing to brute-force, and a slow KDF would only add
latency to every request.
"""

from __future__ import annotations

import hashlib
import hmac
import re
import secrets
from dataclasses import dataclass

PREFIX = "sct_"
_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
_ID_LENGTH = 12
_SECRET_BYTES = 32
# token_urlsafe(32): 43 base64url chars, "_" included.
_FORMAT = re.compile(r"^sct_([a-z2-7]{12})_([A-Za-z0-9_-]{43})$")


@dataclass(frozen=True)
class NewKey:
    key_id: str
    plaintext: str
    digest: str


def generate() -> NewKey:
    key_id = "".join(secrets.choice(_ID_ALPHABET) for _ in range(_ID_LENGTH))
    secret = secrets.token_urlsafe(_SECRET_BYTES)
    return NewKey(key_id=key_id, plaintext=f"{PREFIX}{key_id}_{secret}", digest=digest(secret))


def parse(key: str) -> tuple[str, str] | None:
    """(key_id, secret), or None for anything not shaped like a key."""
    m = _FORMAT.match(key)
    return (m.group(1), m.group(2)) if m else None


def digest(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


def matches(secret: str, stored: str) -> bool:
    return hmac.compare_digest(digest(secret), stored)
