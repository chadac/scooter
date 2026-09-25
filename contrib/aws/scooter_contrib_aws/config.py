"""AWS settings, owned by this contrib rather than the broker app.

Same env vars the broker read before (AWS_ENABLED, AWS_REGION,
AWS_STS_EXTERNAL_ID, AWS_BROKER_PRINCIPAL_ARN, AWS_ACCOUNTS_FILE,
AWS_ROLE_TTL_HOURS, AWS_APPROVER_CLAIM, AWS_AGENT_HOST_URL, AWS_NOTIFY_*,
AWS_SWEEP_INTERVAL), so a deployment needs no manifest change. Why: PR #599.

What is deliberately NOT here, because it is not aws's:

  * the authorizer — substrate, not a feature (#595). Built by the app from FGA_*
    and handed over in a BrokerContext (#624); a provider that could construct
    one could construct a NoopAuthorizer and authorize itself.
  * the shared `broker` database — BROKER_DB_* (#625). Three other stores read it.
  * the approver allowlist — core auth sets Identity.is_approver and shares reads
    it too, so APPROVER_SERVICE_ACCOUNTS is the platform's (#632).
"""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings


class AwsSettings(ScooterBaseSettings):
    aws_enabled: bool = False
    aws_region: str = "us-east-1"
    aws_sts_external_id: str = "agent-permissions-broker"
    # The base role the broker assumes into each account; the account registry's
    # per-account broker_role_arn is assumed FROM this principal.
    aws_broker_principal_arn: str = ""
    # Path to the account-registry JSON (a mounted ConfigMap).
    aws_accounts_file: str = ""
    aws_role_ttl_hours: int = 12
    # Which identity claim authorizes an approver — must match how the FGA
    # approver tuples are seeded. "email" | "id" | "name". This one IS aws's: it
    # keys aws's own tuples, unlike the SA allowlist that core auth owns.
    aws_approver_claim: str = "email"

    # Notify the agent-host when a request is created so it raises the approval
    # interrupt. Empty = no notify (local/dev). Kept under the aws_ name rather
    # than the base agent_host_url so the manifest's AWS_AGENT_HOST_URL keeps
    # working unchanged.
    aws_agent_host_url: str = ""
    aws_notify_attempts: int = 3
    aws_notify_backoff: float = 0.5

    # Sweep interval (seconds) for expired dynamic roles.
    aws_sweep_interval: int = 300


settings = AwsSettings()
