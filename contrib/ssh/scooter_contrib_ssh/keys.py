"""ed25519 key material in SSH wire format: generation, public-key blobs, fingerprints and agent signatures."""

from __future__ import annotations

import base64
import hashlib
import struct
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

KEY_TYPE = b"ssh-ed25519"


def ssh_string(data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + data


@dataclass(frozen=True)
class KeyPair:
    """One user's key: the 32-byte private seed and its public blob."""

    seed: bytes

    @staticmethod
    def generate() -> "KeyPair":
        raw = Ed25519PrivateKey.generate().private_bytes(Encoding.Raw, PrivateFormat.Raw, NoEncryption())
        return KeyPair(seed=raw)

    @property
    def _private(self) -> Ed25519PrivateKey:
        return Ed25519PrivateKey.from_private_bytes(self.seed)

    @property
    def blob(self) -> bytes:
        """The SSH public-key blob: string "ssh-ed25519", string key."""
        pub = self._private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)
        return ssh_string(KEY_TYPE) + ssh_string(pub)

    def authorized_key(self, comment: str) -> str:
        """The one-line OpenSSH public key, as users paste it."""
        return f"{KEY_TYPE.decode()} {base64.b64encode(self.blob).decode()} {comment}".rstrip()

    def sign(self, data: bytes) -> bytes:
        """An SSH signature blob over `data`: string "ssh-ed25519", string signature."""
        return ssh_string(KEY_TYPE) + ssh_string(self._private.sign(data))


def fingerprint(blob: bytes) -> str:
    """The OpenSSH SHA256 fingerprint of a public-key blob."""
    return "SHA256:" + base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
