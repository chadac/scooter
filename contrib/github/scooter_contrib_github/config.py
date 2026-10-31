"""GitHub settings, owned by this contrib; the deployment-wide trigger policy is read through scooter_webhooks_lib.policy instead."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class GitHubSettings(ScooterBaseSettings):
    # The GitHub App, preferred: the broker mints an installation token from these and webhooks mints one per repo.
    github_app_id: str = ""
    github_app_private_key: str = ""  # PEM content or a path to a .pem file
    # Broker only; webhooks looks the installation up per repo instead.
    github_app_installation_id: int = 0
    # Comma-separated accounts the App serves; empty serves the one installation.
    github_app_owners: str = ""

    # PAT fallback when github_app_* is unset, and the optional token on the public email lookup.
    github_token: str = ""
    # github.com, or a GHES hostname.
    github_host: str = "github.com"
    # A `module:attr` ForgePolicy (scooter_broker_lib.forge) checked on every request the broker makes to GitHub; empty allows all.
    github_forge_policy: str = ""

    # Acting as the user (the App's user-to-server OAuth flow, or a pasted PAT); off unless enabled.
    github_user_auth_enabled: bool = False
    github_app_client_id: str = ""
    github_app_client_secret: str = ""
    # Where GitHub sends the browser back: <public url>/contrib-api/github/callback.
    github_oauth_redirect_url: str = ""

    github_enabled: bool = False
    github_webhook_secret: str = ""

    @property
    def app_owners(self) -> tuple[str, ...]:
        return tuple(o.strip().lower() for o in self.github_app_owners.split(",") if o.strip())


settings = GitHubSettings()
