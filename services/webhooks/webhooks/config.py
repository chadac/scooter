"""Webhooks service configuration."""

import hmac

from fastapi import HTTPException, Security
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import model_validator
from pydantic_settings import BaseSettings

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
    # default (binaries land in the sandbox at /workspace/uploads via the agent-host).
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

    # --- Author trust (see webhooks/access.py) ------------------------------
    # A webhook signature proves the PROVIDER sent the event, not who wrote the
    # comment in it. On a public repo, anyone with an account can comment the
    # mention pattern and get a sandbox with push credentials to run their
    # instructions — so authorship is gated per provider.
    #
    # Comma-separated usernames that may direct the agent, whatever their standing
    # on the resource. GitHub/GitLab logins, Slack user ids (U…), Jira display
    # names or accountIds. Case-insensitive.
    github_allow_usernames: str = ""
    gitlab_allow_usernames: str = ""
    slack_allow_users: str = ""
    jira_allow_users: str = ""

    # GitHub `author_association` values trusted WITHOUT being listed above —
    # people who already have standing on the repo. Rides along in the payload, so
    # this is a secure default that needs no list maintained as collaborators
    # change. Deliberately excludes CONTRIBUTOR ("has a merged commit" is a past
    # contribution, not authority to spend compute now). Set empty to require the
    # explicit allowlist and nothing else.
    github_trusted_associations: str = "OWNER,MEMBER,COLLABORATOR"

    # Forward an untrusted author's comment into an existing conversation, fenced
    # as untrusted data, instead of dropping it? Off by default: text in the
    # context window IS the prompt-injection vector, so awareness of drive-by
    # comments is opt-in rather than the default posture.
    forward_untrusted_comments: bool = False

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
