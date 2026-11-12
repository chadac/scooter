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


@pytest.fixture(autouse=True)
def no_merge_blocker_lookup():
    """Handlers would read GitHub for the merge note; tests opt in by patching it."""
    from unittest.mock import AsyncMock, patch

    from scooter_contrib_github import webhooks_handler as gh

    with patch.object(gh, "_merge_blockers", new=AsyncMock(return_value=None)) as lookup:
        yield lookup
