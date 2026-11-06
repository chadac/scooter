"""mcpservers settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class McpServersSettings(ScooterBaseSettings):
    mcpservers_enabled: bool = False
