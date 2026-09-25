"""GitHub settings, owned by this contrib rather than the two apps.

Same env vars both services read before (GITHUB_APP_ID / _PRIVATE_KEY /
_INSTALLATION_ID, GITHUB_TOKEN, GITHUB_ENABLED, GITHUB_WEBHOOK_SECRET), so a
deployment needs no manifest change. Why: PR #591.

Deployment-wide trigger policy (mention pattern, label, ignored users, the
ignore-bot fallback) is NOT here: it is one deployment's policy, read through
scooter_webhooks_lib.policy.
"""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class GitHubSettings(ScooterBaseSettings):
    # GitHub App — preferred everywhere. The broker mints an installation token
    # from these (API proxy AND git credentials); webhooks mints one per repo to
    # post comments and to learn its own `<slug>[bot]` login.
    github_app_id: str = ""
    github_app_private_key: str = ""  # PEM content or path to .pem file
    # Broker only: the single installation it vends for. Webhooks looks the
    # installation up per repo instead, so it needs no id.
    github_app_installation_id: int = 0

    # PAT fallback, used when github_app_* is unset. Also the (optional) token on
    # the public /users/{login} email lookup.
    github_token: str = ""

    # Webhooks side.
    github_enabled: bool = False
    github_webhook_secret: str = ""


settings = GitHubSettings()
