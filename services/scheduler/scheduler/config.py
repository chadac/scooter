"""Scheduler service configuration.

Mirrors the webhooks service: a SQLite dev default, a Postgres DSN assembled from
DB_PASSWORD/components (so the password rides a k8s secretKeyRef, not the manifest).
"""

import hmac

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import model_validator
from pydantic_settings import BaseSettings

_bearer_scheme = HTTPBearer(auto_error=False)


class Settings(BaseSettings):
    # --- store (same convention as webhooks) --------------------------------
    dsn: str = "sqlite+aiosqlite:////tmp/scheduler.db"
    db_host: str = "local"
    db_port: int = 5432
    db_user: str = "scheduler"
    db_password: str = ""  # secretKeyRef -> Postgres DSN assembled
    db_name: str = "scheduler"

    # --- spawn target -------------------------------------------------------
    # The agent-host /agui endpoint a due task POSTs its prompt to (same spawn the
    # webhooks service uses). The SA-token trust chain lets us set `owner`.
    agent_host_url: str = "http://agent-host:8080"
    # Path to the projected SA token to present so the agent-host honors `owner`
    # (its WEBHOOKS_SERVICE_ACCOUNT list must include this scheduler's SA).
    sa_token_path: str = "/var/run/secrets/agent-host/token"

    # --- API auth (internal service) ----------------------------------------
    # A relay/API key gating the /tasks API. Empty -> auth disabled (dev only).
    relay_key: str = ""

    # --- scheduler loop -----------------------------------------------------
    tick_seconds: int = 30  # how often the loop checks for due tasks

    model_config = {"env_prefix": "", "case_sensitive": False}

    @model_validator(mode="after")
    def _assemble_dsn(self) -> "Settings":
        if self.db_password and not self.dsn.startswith("postgresql"):
            self.dsn = (
                f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
                f"@{self.db_host}:{self.db_port}/{self.db_name}"
            )
        return self


settings = Settings()


def require_relay_key(
    creds: HTTPAuthorizationCredentials | None = Security(_bearer_scheme),
) -> None:
    """Gate the /tasks API on the relay key (constant-time compare). No key set →
    auth disabled (dev/local only)."""
    if not settings.relay_key:
        return
    if creds is None or not hmac.compare_digest(creds.credentials, settings.relay_key):
        raise HTTPException(status_code=401, detail="invalid or missing API key")
