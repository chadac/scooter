"""The user-secrets keyring: created once, adopted by every other replica."""

from __future__ import annotations

import base64
import copy

from kubernetes.client.exceptions import ApiException

from broker.core.user_secrets_key import NAME, load_or_create_keyring
from scooter_broker_lib.user_secrets import open_sealed, seal


class FakeCore:
    def __init__(self):
        self.secrets: dict[str, object] = {}
        # Simulates another replica creating the Secret between our read and create.
        self.race_with = None

    def read_namespaced_secret(self, name, ns):
        if name not in self.secrets:
            raise ApiException(status=404)
        return copy.deepcopy(self.secrets[name])

    def create_namespaced_secret(self, ns, body):
        if self.race_with is not None:
            self.secrets[body.metadata.name], self.race_with = self.race_with, None
            raise ApiException(status=409)
        if body.metadata.name in self.secrets:
            raise ApiException(status=409)
        self.secrets[body.metadata.name] = copy.deepcopy(body)


def test_the_first_load_creates_and_the_next_adopts():
    core = FakeCore()
    first = load_or_create_keyring(core, "ns")
    assert NAME in core.secrets
    second = load_or_create_keyring(core, "ns")
    assert second == first
    assert open_sealed(second, seal(first, "v", "c"), "c") == "v"


def test_a_lost_create_race_adopts_the_winner():
    winner_core = FakeCore()
    winner = load_or_create_keyring(winner_core, "ns")
    core = FakeCore()
    core.race_with = winner_core.secrets[NAME]
    assert load_or_create_keyring(core, "ns") == winner


def test_current_names_the_sealing_key():
    core = FakeCore()
    ring = load_or_create_keyring(core, "ns")
    data = core.secrets[NAME].data
    assert base64.b64decode(data["current"]).decode() == ring.current
    assert len(base64.b64decode(data[ring.current])) == 32
