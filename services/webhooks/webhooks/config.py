"""Webhooks service configuration.

Stays in the app by design (PR #567). `DatabaseSettings` satisfies
`scooter_webhooks_lib.store.DatabaseConfig` structurally — the lib's store takes
one as an argument rather than importing this module, so the DSN assembly below
(and the secretKeyRef password it exists for) remains the app's business.

The agent-host client takes the same treatment (PR #575): `app.py` hands it this
settings object at startup, so a contrib handler can spawn a conversation through
the lib without reaching into the app.
"""

import hmac

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import model_validator
from pydantic_settings import BaseSettings

from scooter_lib.settings import ScooterBaseSettings

_bearer_scheme = HTTPBearer(auto_error=False)


class DatabaseSettings(BaseSettings):
    """Conversation-mapping store. SQLite by default (dev). For a durable
    Postgres store, either set DSN directly (postgresql+asyncpg://...) OR provide
    DB_PASSWORD (+ optionally DB_HOST/DB_USER/DB_NAME/DB_PORT) and the DSN is
    assembled — so the password can come from a k8s secretKeyRef without baking a
    full connection string (with the password) into the manifest."""

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
        # If a password is provided and DSN wasn't explicitly set to Postgres,
        # build the asyncpg DSN from the components. (A DSN that already names a
        # driver wins — explicit override.)
        if self.db_password and not self.dsn.startswith("postgresql"):
            dsn = (
                f"postgresql+asyncpg://{self.db_user}:{self.db_password}"
                f"@{self.db_host}:{self.db_port}/{self.db_name}"
            )
            if self.db_sslmode:
                dsn += f"?ssl={self.db_sslmode}"
            self.dsn = dsn
        return self


class WebhooksSettings(ScooterBaseSettings):
    """Settings specific to the webhooks service."""

    # Overrides the lib's "" default on purpose: empty means "auto-linking off"
    # to the broker, but a misconfiguration here. Don't collapse them. PR #572.
    agent_host_url: str = "http://agent-host.agent-sandbox.svc.cluster.local:8080"

    # Root log level (LOG_LEVEL env). INFO by default; DEBUG for verbose tracing.
    log_level: str = "INFO"

    # Bring-your-own-Claude: the HS256 signing key for join tokens (SAME secret the agent-host
    # signs with). Set → webhooks verifies + proxies /claude-bridge/connect to the agent-host's
    # internal /remote-agent/connect. Empty → the bridge is disabled (closes with 4404).
    remote_agent_join_secret: str = ""

    # Integration toggles
    github_enabled: bool = False

    # Webhook secrets (signature validation)
    github_webhook_secret: str = ""

    # Tokens for posting responses back to services
    github_token: str = ""  # PAT fallback (used if github_app_id is empty)

    # GitHub App authentication
    github_app_id: str = ""
    github_app_private_key: str = ""  # PEM content or path to .pem file
    github_client_id: str = ""  # Client ID for installation lookup

    # Shared API key for internal relay endpoints
    relay_api_key: str = ""

    # Test webhook (/webhooks/test) for e2e — OFF in prod.
    test_webhook_enabled: bool = False

    # Trigger pattern (text mention) + issue/PR label that spawns a conversation
    mention_pattern: str = "@agent"
    label_trigger: str = "scooter"

    # Comment/review authors to drop (comma-separated), matched case-insensitively.
    # GitLab payloads carry no bot flag, so this is the only author lever there.
    ignore_usernames: str = ""

    # Fallback for when github_app_* is unset and the agent's own "<slug>[bot]"
    # login can't be resolved: drop any Bot-authored GitHub comment/review that
    # doesn't mention the agent. Its own comments otherwise come back as webhooks
    # — at interrupt priority for reviews (PR #530).
    ignore_bot_authors: bool = True

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
