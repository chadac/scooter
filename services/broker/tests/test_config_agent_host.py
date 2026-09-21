"""BrokerSettings inherits the agent-host fields without changing broker behaviour.

`agent_host_url == ""` is the broker's auto-linking OFF switch (see
scooter_broker_lib.autolink, which returns early on a falsy url). Inheriting the
field from scooter_lib must not quietly give it a real default, or auto-linking
turns itself on in every environment that does not set the variable.
"""

from __future__ import annotations

import pytest

from broker.config import BrokerSettings
from scooter_lib.settings import AgentHostSettings


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("AGENT_HOST_URL", raising=False)


def test_broker_settings_carries_the_shared_agent_host_fields():
    assert issubclass(BrokerSettings, AgentHostSettings)


def test_agent_host_url_is_still_empty_by_default():
    # The disable switch. If this ever comes back non-empty, the broker starts
    # POSTing links to an address that may not exist, in local/dev included.
    assert BrokerSettings().agent_host_url == ""


def test_agent_host_url_still_reads_its_env_var(monkeypatch):
    monkeypatch.setenv("AGENT_HOST_URL", "http://agent-host:8080")
    assert BrokerSettings().agent_host_url == "http://agent-host:8080"


def test_the_brokers_own_settings_are_untouched():
    s = BrokerSettings()
    assert s.token_audience == "agent-broker"
    assert s.sandbox_namespace == "agent-sandbox"
