"""Bind the lib surfaces the webhooks service binds at startup.

`policy` is GIVEN the deployment's trigger rules (#577) and `agent_host_client`
its settings (#575) — production does both in `webhooks.app`. A test that imports
this handler directly gets neither and trips the deliberate "init() was never
called" guard, so bind them here. Why: PR #588.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from scooter_contrib_slack.config import settings as slack_settings
from scooter_webhooks_lib import agent_host_client, policy


@dataclass
class TriggerPolicy:
    """The deployment policy — owned by the app, never by a contrib. These are the
    values a test drives the handler with; a test that needs others rebinds it."""

    mention_pattern: str = "@scooter"
    label_trigger: str = "scooter"
    ignore_usernames: str = ""
    ignore_bot_authors: bool = True

    def get_repo_descriptions(self) -> dict[str, str]:
        return {}


@pytest.fixture(autouse=True)
def _bind_lib_config():
    policy.init(TriggerPolicy())
    agent_host_client.init(slack_settings)
    yield
