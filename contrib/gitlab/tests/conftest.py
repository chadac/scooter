"""Bind the deployment-wide trigger policy the handler reads, since these tests drive the handler without the service."""

from __future__ import annotations

from dataclasses import dataclass, field

import pytest

from scooter_webhooks_lib import policy


@dataclass
class TriggerPolicy:
    """The defaults the webhooks service ships."""

    mention_pattern: str = "@agent"
    label_trigger: str = "scooter"
    ignore_usernames: str = ""
    ignore_bot_authors: bool = True
    repo_descriptions: dict[str, str] = field(default_factory=dict)

    def get_repo_descriptions(self) -> dict[str, str]:
        return self.repo_descriptions


@pytest.fixture(autouse=True)
def trigger_policy() -> TriggerPolicy:
    cfg = TriggerPolicy()
    policy.init(cfg)
    return cfg
