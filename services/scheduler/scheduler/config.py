"""Scheduler service configuration.

Explicit store backend selection: postgres (fail loudly if password empty/missing) or
sqlite (must be chosen deliberately). No silent fallback.
"""

import hmac
import logging
from typing import Literal

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import model_validator
from pydantic_settings import BaseSettings

_bearer_scheme = HTTPBearer(auto_error=False)
logger = logging.getLogger("scheduler.config")


class Settings(BaseSettings):
    # --- store (explicit backend selection) --------------------------------
    # Backend choice: postgres (production) or sqlite (deliberate dev/test only).
    # Default postgres. postgres + empty/missing password -> FAIL LOUDLY at startup.
    store_backend: Literal["postgres", "sqlite"] = "postgres"
    
    dsn: str = "sqlite+aiosqlite:////tmp/scheduler.db"
    db_host: str = "local"
    db_port: int = 5432
    db_user: str = "scheduler"
    db_password: str = ""  # secretKeyRef -> Postgres DSN assembled
    db_name: str = "scheduler"
    db_sslmode: str = ""  # e.g. "require" for RDS; empty = no ssl param

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

    # --- run history retention ----------------------------------------------
    # Delete task_runs older than this many days. 0 = disabled (no retention sweep).
    run_retention_days: int = 90

    # --- observability ------------------------------------------------------
    # OpenTelemetry metrics (OTLP export). Off by default; set OTEL_METRICS_ENABLED=1
    # to enable. Endpoint/headers come from standard OTEL_EXPORTER_OTLP_* env vars.
    otel_metrics_enabled: bool = False

    # --- logging ------------------------------------------------------------
    # Root log level (LOG_LEVEL env). INFO shows task fires + spawns; DEBUG is
    # verbose. Without this the root logger defaults to WARNING and info/debug
    # messages never reach stdout.
    log_level: str = "INFO"

    model_config = {"env_prefix": "", "case_sensitive": False}

    @model_validator(mode="after")
    def _assemble_dsn(self) -> "Settings":
        if self.store_backend == "postgres":
            # Postgres selected: password MUST be present. Empty/missing -> FAIL LOUDLY.
            if not self.db_password:
                raise ValueError(
                    "store_backend=postgres requires DB_PASSWORD to be set (non-empty). "
                    "An empty password would silently fall back to SQLite, breaking the "
                    "double-fire guard across replicas. Set DB_PASSWORD or choose "
                    "store_backend=sqlite explicitly for dev."
                )
            # Build the Postgres DSN from components (unless already explicit).
            if not self.dsn.startswith("postgresql"):
                dsn = (
                    f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
                    f"@{self.db_host}:{self.db_port}/{self.db_name}"
                )
                # asyncpg takes ssl via a query param; map an sslmode like "require" to it.
                if self.db_sslmode:
                    dsn += f"?ssl={self.db_sslmode}"
                self.dsn = dsn
        # else store_backend == "sqlite": keep the dsn as-is (default or explicit).
        
        # Log the resolved backend (password redacted). This is the visibility gap —
        # without a log line, a silent fallback is invisible.
        backend = "postgres" if self.dsn.startswith("postgresql") else "sqlite"
        dsn_safe = self.dsn.replace(self.db_password, "***") if self.db_password else self.dsn
        logger.info("store backend: %s (dsn: %s)", backend, dsn_safe)
        
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
