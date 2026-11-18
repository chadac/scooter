"""databricks settings, read from the broker's DATABRICKS_* env."""

from __future__ import annotations

import json

from scooter_lib.settings import ScooterBaseSettings


class DatabricksSettings(ScooterBaseSettings):
    # JSON {name: host}.
    databricks_workspaces: str = "{}"
    databricks_tokens_dir: str = "/var/run/scooter/databricks"

    @property
    def workspaces(self) -> dict[str, str]:
        raw = json.loads(self.databricks_workspaces or "{}")
        return {str(k): str(v).strip().rstrip("/") for k, v in raw.items() if str(v).strip()}
