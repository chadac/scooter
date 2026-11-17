"""The forge CA store: create once, adopt across replicas, add a CA per new host set, never publish the keys."""

from __future__ import annotations

import base64
import copy

import pytest
from kubernetes.client.exceptions import ApiException

from broker.forge.ca import ca_hosts
from broker.forge.ca_store import NAME, load_or_create_cas


class FakeCore:
    """Just enough of CoreV1Api, with resourceVersion conflicts."""

    def __init__(self):
        self.secrets: dict[str, object] = {}
        self.configmaps: dict[str, object] = {}
        self.version = 0
        self.conflict_next_write = False

    def _get(self, store, name):
        if name not in store:
            raise ApiException(status=404)
        return copy.deepcopy(store[name])

    def _put(self, store, body, create):
        if self.conflict_next_write:
            self.conflict_next_write = False
            raise ApiException(status=409)
        name = body.metadata.name
        if create and name in store:
            raise ApiException(status=409)
        if not create and store[name].metadata.resource_version != body.metadata.resource_version:
            raise ApiException(status=409)
        self.version += 1
        body = copy.deepcopy(body)
        body.metadata.resource_version = str(self.version)
        store[name] = body

    def read_namespaced_secret(self, name, ns):
        return self._get(self.secrets, name)

    def create_namespaced_secret(self, ns, body):
        self._put(self.secrets, body, create=True)

    def replace_namespaced_secret(self, name, ns, body):
        self._put(self.secrets, body, create=False)

    def read_namespaced_config_map(self, name, ns):
        return self._get(self.configmaps, name)

    def create_namespaced_config_map(self, ns, body):
        self._put(self.configmaps, body, create=True)

    def replace_namespaced_config_map(self, name, ns, body):
        self._put(self.configmaps, body, create=False)


def test_created_once_then_adopted():
    core = FakeCore()
    first = load_or_create_cas(core, "ns", ["github.com", "api.github.com"])
    second = load_or_create_cas(core, "ns", ["api.github.com", "github.com"])
    assert first == second
    assert [ca_hosts(ca.cert_pem) for ca in first] == [["api.github.com", "github.com"]]

    cm = core.configmaps[NAME].data
    assert cm["ca.crt"] == first[0].cert_pem.decode()
    assert cm["hosts"] == "api.github.com\ngithub.com\n"
    assert "PRIVATE KEY" not in "".join(cm.values())
    assert base64.b64decode(core.secrets[NAME].data["ca.key"]) == first[0].key_pem


def test_a_new_host_adds_a_ca_and_keeps_the_trusted_one():
    """A running sandbox trusts the CAs it booted with, so they must not change (#1053)."""
    core = FakeCore()
    [old] = load_or_create_cas(core, "ns", ["github.com"])
    cas = load_or_create_cas(core, "ns", ["github.com", "gitlab.com"])
    assert cas[0] == old
    assert [ca_hosts(ca.cert_pem) for ca in cas] == [["github.com"], ["gitlab.com"]]
    assert core.configmaps[NAME].data["ca.crt"] == "".join(ca.cert_pem.decode() for ca in cas)
    assert core.configmaps[NAME].data["hosts"] == "github.com\ngitlab.com\n"
    # A replica that restarts reads back the same pair, in order.
    assert load_or_create_cas(core, "ns", ["gitlab.com", "github.com"]) == cas


def test_a_ca_for_only_removed_hosts_is_dropped():
    core = FakeCore()
    load_or_create_cas(core, "ns", ["github.com"])
    [_, gitlab] = load_or_create_cas(core, "ns", ["github.com", "gitlab.com"])
    assert load_or_create_cas(core, "ns", ["gitlab.com"]) == [gitlab]
    assert core.configmaps[NAME].data["ca.crt"] == gitlab.cert_pem.decode()
    assert core.configmaps[NAME].data["hosts"] == "gitlab.com\n"


def test_losing_a_race_adopts_the_winner():
    core = FakeCore()
    winner = load_or_create_cas(core, "ns", ["github.com"])
    # A replica that read the old state and lost the replace retries and adopts.
    core.conflict_next_write = True
    assert load_or_create_cas(core, "ns", ["github.com"]) == winner


def test_no_hosts_is_an_error():
    with pytest.raises(ValueError):
        load_or_create_cas(FakeCore(), "ns", [])
