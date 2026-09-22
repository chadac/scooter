"""Wire the lib modules the way the app wires them.

`scooter_webhooks_lib.agent_host_client` is GIVEN its config (PR #575) instead of
reading the app's settings singleton, and the per-provider email resolvers register
on import. Production does both in `webhooks.app`; a test that imports a handler
module directly gets neither, so do it here — otherwise every handler test fails on
the deliberate "init() was never called" guard.
"""

from __future__ import annotations

import pytest

from scooter_webhooks_lib import agent_host_client

import webhooks.identity_resolve  # noqa: F401  (resolver registration)
import webhooks.resource_shapes  # noqa: F401  (resource-shape registration)
from webhooks.config import settings


@pytest.fixture(autouse=True)
def _bind_agent_host_config():
    agent_host_client.init(settings)
    yield
