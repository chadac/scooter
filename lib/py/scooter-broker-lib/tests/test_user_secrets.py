"""Sealed user secrets open only with their own key and context."""

from __future__ import annotations

import pytest

from scooter_broker_lib.user_secrets import KeyRing, SecretBox, SecretError, open_sealed, seal


def test_round_trip():
    ring = KeyRing.generate()
    assert open_sealed(ring, seal(ring, "ghu_secret", "github:alice"), "github:alice") == "ghu_secret"


def test_the_plaintext_is_not_in_the_sealed_value():
    ring = KeyRing.generate()
    assert "ghu_secret" not in seal(ring, "ghu_secret", "github:alice")


def test_another_context_fails_to_open():
    ring = KeyRing.generate()
    sealed = seal(ring, "ghu_secret", "github:alice")
    with pytest.raises(SecretError):
        open_sealed(ring, sealed, "github:bob")


def test_tampering_fails_to_open():
    ring = KeyRing.generate()
    sealed = seal(ring, "ghu_secret", "c")
    flipped = sealed[:-2] + ("A" if sealed[-2] != "A" else "B") + sealed[-1]
    with pytest.raises(SecretError):
        open_sealed(ring, flipped, "c")


def test_old_rows_open_after_a_new_key_becomes_current():
    old = KeyRing.generate("k1")
    sealed = seal(old, "v", "c")
    rotated = KeyRing(keys={**old.keys, **KeyRing.generate("k2").keys}, current="k2")
    assert open_sealed(rotated, sealed, "c") == "v"
    assert seal(rotated, "v", "c").startswith("v1.k2.")


def test_an_unknown_key_fails_to_open():
    sealed = seal(KeyRing.generate("k1"), "v", "c")
    with pytest.raises(SecretError, match="unknown key"):
        open_sealed(KeyRing.generate("k9"), sealed, "c")


def test_garbage_fails_to_open():
    with pytest.raises(SecretError):
        open_sealed(KeyRing.generate(), "not sealed", "c")


@pytest.mark.parametrize(
    "keys,current",
    [({"k1": b"short"}, "k1"), ({"k1": b"x" * 32}, "k2"), ({"Bad.Id": b"x" * 32}, "Bad.Id")],
)
def test_an_invalid_keyring_is_refused(keys, current):
    with pytest.raises(ValueError):
        KeyRing(keys=keys, current=current)


async def test_the_box_loads_its_keyring_once():
    loads = 0
    ring = KeyRing.generate()

    async def load() -> KeyRing:
        nonlocal loads
        loads += 1
        return ring

    box = SecretBox(load)
    assert await box.open(await box.seal("v", "c"), "c") == "v"
    assert loads == 1


async def test_a_failed_load_is_retried():
    attempts = 0

    async def load() -> KeyRing:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise RuntimeError("apiserver down")
        return KeyRing.generate()

    box = SecretBox(load)
    with pytest.raises(RuntimeError):
        await box.seal("v", "c")
    assert (await box.seal("v", "c")).startswith("v1.")
