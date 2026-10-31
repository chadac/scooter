"""The ssh-key seam: lookups go to whoever provided one, and one failing listener does not stop the rest."""

from __future__ import annotations

import pytest

from scooter_broker_lib import ssh_keys


@pytest.fixture(autouse=True)
def _clean():
    saved = list(ssh_keys._listeners)
    yield
    ssh_keys._listeners[:] = saved
    ssh_keys.provide_lookup(None)


async def test_no_lookup_means_no_key():
    assert await ssh_keys.public_key("alice") is None


async def test_the_provided_lookup_answers():
    async def lookup(user: str) -> str:
        return f"ssh-ed25519 AAAA {user}"

    ssh_keys.provide_lookup(lookup)
    assert await ssh_keys.public_key("alice") == "ssh-ed25519 AAAA alice"


async def test_a_failing_listener_does_not_stop_the_rest():
    seen = []

    @ssh_keys.on_ssh_key_change
    async def broken(change):
        raise RuntimeError("forge down")

    @ssh_keys.on_ssh_key_change
    async def ok(change):
        seen.append(change)

    change = ssh_keys.SshKeyChange(user="alice", new="new", old="old")
    await ssh_keys.announce(change)
    assert seen == [change]
