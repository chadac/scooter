"""mcpservers settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings

from .registry import DEFAULT_URL


class McpServersSettings(ScooterBaseSettings):
    mcpservers_enabled: bool = False
    # Deployments behind a mirror can point live search elsewhere.
    mcpservers_registry_url: str = DEFAULT_URL
