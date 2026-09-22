"""GitLab settings, owned by this contrib rather than the two apps.

Same env vars both services read before (GITLAB_TOKEN / GITLAB_WEBHOOK_SECRET /
GITLAB_ENABLED / DEFAULT_GITLAB_REPO), so a deployment needs no manifest change.

Deployment-wide trigger policy (mention pattern, label, ignored users) is NOT
here: it is one deployment's policy, read through scooter_webhooks_lib.policy.
Why: PR #580.
"""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class GitlabSettings(ScooterBaseSettings):
    # Broker side: the PAT the proxy injects, and what gates the provider.
    gitlab_token: str = ""

    # Webhooks side.
    gitlab_enabled: bool = True
    gitlab_webhook_secret: str = ""
    default_gitlab_repo: str = ""


settings = GitlabSettings()
