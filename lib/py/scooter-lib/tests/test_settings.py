"""AgentHostSettings — the agent-host contact fields a contrib needs without the app.

The subclassing tests matter more than they look: the two services disagree on
the `agent_host_url` default, and the disagreement is semantic, not cosmetic.
Collapsing them onto one default would silently change behaviour in a way no
existing test covers.
"""

from __future__ import annotations

import pytest

from scooter_lib.settings import AgentHostSettings


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    for var in ("AGENT_HOST_URL", "AGENT_HOST_TOKEN_PATH", "AGENT_MANAGER_URL"):
        monkeypatch.delenv(var, raising=False)


def test_agent_host_url_defaults_to_empty():
    # EMPTY IS MEANINGFUL. The broker's auto-linking clients treat a falsy url as
    # "not configured, do nothing" rather than an error. If this ever defaulted
    # to a real in-cluster address, auto-linking would switch itself ON wherever
    # the variable is unset — including local runs — and start POSTing to a host
    # that may not exist.
    assert AgentHostSettings().agent_host_url == ""


def test_token_path_defaults_to_the_projected_sa_token():
    assert AgentHostSettings().agent_host_token_path == "/var/run/secrets/agent-host/token"


def test_agent_manager_url_defaults_to_empty():
    # Empty -> the "View conversation" deep-link degrades to the raw id.
    assert AgentHostSettings().agent_manager_url == ""


@pytest.mark.parametrize(
    "env_var,field,value",
    [
        ("AGENT_HOST_URL", "agent_host_url", "http://agent-host:8080"),
        ("AGENT_HOST_TOKEN_PATH", "agent_host_token_path", "/tmp/tok"),
        ("AGENT_MANAGER_URL", "agent_manager_url", "https://scooter.example.test"),
    ],
)
def test_reads_the_env_var_the_manifests_already_inject(monkeypatch, env_var, field, value):
    # Wire compatibility is the whole reason the provider migrations can be done
    # one at a time: a contrib built on this reads the SAME variables
    # modules/broker.nix and modules/webhooks.nix already set, so no manifest
    # changes and no flag day.
    monkeypatch.setenv(env_var, value)
    assert getattr(AgentHostSettings(), field) == value


def test_env_lookup_is_case_insensitive(monkeypatch):
    monkeypatch.setenv("agent_host_url", "http://lowercase:8080")
    assert AgentHostSettings().agent_host_url == "http://lowercase:8080"


def test_a_subclass_may_override_a_default_without_touching_the_base():
    # This is exactly what webhooks does, and the reason the base default is "".
    class Sub(AgentHostSettings):
        agent_host_url: str = "http://agent-host.agent-sandbox.svc.cluster.local:8080"

    assert Sub().agent_host_url == "http://agent-host.agent-sandbox.svc.cluster.local:8080"
    assert AgentHostSettings().agent_host_url == ""


def test_a_subclass_still_reads_the_env_over_its_own_default(monkeypatch):
    class Sub(AgentHostSettings):
        agent_host_url: str = "http://default:8080"

    monkeypatch.setenv("AGENT_HOST_URL", "http://from-env:8080")
    assert Sub().agent_host_url == "http://from-env:8080"


def test_two_instances_read_the_same_environment(monkeypatch):
    # A contrib constructs its own instance rather than importing the app's.
    # Both must see the same deployment config, which is what makes that safe.
    monkeypatch.setenv("AGENT_HOST_URL", "http://shared:8080")
    assert AgentHostSettings().agent_host_url == AgentHostSettings().agent_host_url == "http://shared:8080"
