"""Keys and signatures in the exact wire format OpenSSH reads."""

from __future__ import annotations

import base64
import hashlib
import struct

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from scooter_contrib_ssh.keys import KeyPair, fingerprint


def strings(blob: bytes) -> list[bytes]:
    out = []
    while blob:
        (n,) = struct.unpack(">I", blob[:4])
        out.append(blob[4 : 4 + n])
        blob = blob[4 + n :]
    return out


def test_the_blob_is_type_then_32_byte_key():
    kind, pub = strings(KeyPair.generate().blob)
    assert kind == b"ssh-ed25519" and len(pub) == 32


def test_the_authorized_key_line_round_trips_the_blob():
    pair = KeyPair.generate()
    kind, b64, comment = pair.authorized_key("alice (scooter)").split(" ", 2)
    assert kind == "ssh-ed25519" and base64.b64decode(b64) == pair.blob and comment == "alice (scooter)"


def test_a_signature_verifies_under_the_public_key():
    pair = KeyPair.generate()
    kind, sig = strings(pair.sign(b"session data"))
    assert kind == b"ssh-ed25519"
    Ed25519PublicKey.from_public_bytes(strings(pair.blob)[1]).verify(sig, b"session data")


def test_the_fingerprint_is_openssh_sha256():
    blob = KeyPair.generate().blob
    expected = base64.b64encode(hashlib.sha256(blob).digest()).decode().rstrip("=")
    assert fingerprint(blob) == f"SHA256:{expected}"
