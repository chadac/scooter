"""Webhooks service configuration."""

import hmac
import os
import logging
from typing import Literal

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import Field, model_validator
from pydantic_settings import BaseSettings

_bearer_scheme = HTTPBearer(auto_error=False)
logger = logging.getLogger("webhooks.config")


class DatabaseSettings(BaseSettings):
    """Conversation-mapping store. Explicit backend selection: postgres (production,
    fail loudly if password empty/missing) or sqlite (must be chosen deliberately).
    No silent fallback."""

    # Backend choice: postgres (production) or sqlite (dev/test).
    # Default sqlite (safe for dev/build/test). Production sets STORE_BACKEND=postgres.
    store_backend: Literal["postgres", "sqlite"] = Field(
        default_factory=lambda: os.getenv("STORE_BACKEND", "sqlite"),
        description="Backend choice: postgres (production) or sqlite (dev/test)"
    )
    
    dsn: str = "sqlite+aiosqlite:////tmp/webhooks.db"
    db_host: str = "local"  # also informational, for logging
    db_port: int = 5432
    db_user: str = "webhooks"
    db_password: str = ""  # set (e.g. via secretKeyRef) -> Postgres DSN assembled
    db_name: str = "webhooks"
    db_sslmode: str = ""  # e.g. "require" for RDS; empty = no ssl param

    model_config = {"env_prefix": "", "case_sensitive": False}

    @model_validator(mode="after")
    def _assemble_dsn(self) -> "DatabaseSettings":
        if self.store_backend == "postgres":
            # Postgres selected: password MUST be present. Empty/missing -> FAIL LOUDLY.
            if not self.db_password:
                raise ValueError(
                    "store_backend=postgres requires DB_PASSWORD to be set (non-empty). "
                    "An empty password would silently fall back to SQLite. Set DB_PASSWORD "
                    "or choose store_backend=sqlite explicitly for dev."
                )
            # Build the Postgres DSN from components (unless already explicit).
            if not self.dsn.startswith("postgresql"):
                dsn = (
                    f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
                    f"@{self.db_host}:{self.db_port}/{self.db_name}"
                )
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


class WebhooksSettings(BaseSettings):
    """Settings specific to the webhooks service."""

    # The agent-host (AG-UI). Webhooks spawn conversations via POST {url}/agui.
    agent_host_url: str = "http://agent-host.agent-sandbox.svc.cluster.local:8080"
    # Projected ServiceAccount token (audience agent-host) we present on /agui so the
    # agent-host can verify us (TokenReview) as the trusted caller and honor a
    # conversation `owner`. Not mounted -> no token -> owner ignored (unowned).
    agent_host_token_path: str = "/var/run/secrets/agent-host/token"

    # Root log level (LOG_LEVEL env). INFO by default; DEBUG for verbose tracing.
    log_level: str = "INFO"

    # Bring-your-own-Claude: the HS256 signing key for join tokens (SAME secret the agent-host
    # signs with). Set → webhooks verifies + proxies /claude-bridge/connect to the agent-host's
    # internal /remote-agent/connect. Empty → the bridge is disabled (closes with 4404).
    remote_agent_join_secret: str = ""

    # Integration toggles
    gitlab_enabled: bool = True
    github_enabled: bool = False
    slack_enabled: bool = False
    jira_enabled: bool = False

    # Webhook secrets (signature validation)
    gitlab_webhook_secret: str = ""
    github_webhook_secret: str = ""
    slack_signing_secret: str = ""
    jira_webhook_secret: str = ""

    # Tokens for posting responses back to services
    gitlab_token: str = ""
    github_token: str = ""  # PAT fallback (used if github_app_id is empty)
    slack_bot_token: str = ""

    # Max bytes for an inbound image (Slack file download) forwarded to the agent.
    # Mirrors the agent-host ASSET_MAX_BYTES so a file the agent-host would reject is
    # skipped up front. ~5MB default.
    image_max_bytes: int = 5 * 1024 * 1024

    # Max bytes for ANY inbound Slack attachment (text-representable or binary file)
    # forwarded to the agent. Generalizes image_max_bytes to non-image files. ~10MB
    # default (binaries land in the sandbox at /workspace/.slack via the agent-host).
    file_max_bytes: int = 10 * 1024 * 1024

    # GitHub App authentication
    github_app_id: str = ""
    github_app_private_key: str = ""  # PEM content or path to .pem file
    github_client_id: str = ""  # Client ID for installation lookup

    # Atlassian OAuth 2.0 client credentials
    atlassian_client_id: str = ""
    atlassian_client_secret: str = ""
    atlassian_cloud_id: str = ""
    jira_bot_account_id: str = ""

    # Shared API key for internal relay endpoints
    relay_api_key: str = ""

    # Test webhook (/webhooks/test) for e2e — OFF in prod.
    test_webhook_enabled: bool = False

    # Trigger pattern (text mention) + issue/PR label that spawns a conversation
    mention_pattern: str = "@agent"
    label_trigger: str = "scooter"

    # Bot usernames to ignore
    ignore_usernames: str = ""

    # Public UI base URL for the "View conversation" deep-links posted back to
    # Slack/GitHub/GitLab/Jira: <agent_manager_url>/?thread=<id>. Distinct from
    # agent_host_url (the internal API). Empty -> the link degrades to the raw id.
    agent_manager_url: str = ""

    # Default repo
    default_gitlab_repo: str = ""

    # Pipe-separated repo descriptions
    repo_descriptions: str = ""

    model_config = {"env_prefix": "", "case_sensitive": False}

    def get_repo_descriptions(self) -> dict[str, str]:
        if not self.repo_descriptions:
            return {}
        result = {}
        for entry in self.repo_descriptions.split("|"):
            entry = entry.strip()
            if "=" in entry:
                repo, desc = entry.split("=", 1)
                result[repo.strip()] = desc.strip()
        return result


settings = WebhooksSettings()
db_settings = DatabaseSettings()



def require_relay_key(
    credentials: HTTPAuthorizationCredentials | None = Security(_bearer_scheme),
) -> None:
    """FastAPI dependency that enforces Bearer token auth on internal endpoints."""
    key = settings.relay_api_key
    if not key:
        return
    if credentials is None or not hmac.compare_digest(credentials.credentials, key):
        raise HTTPException(status_code=401, detail="Invalid or missing relay API key")
