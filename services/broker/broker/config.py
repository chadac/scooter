"""Broker configuration — secrets + enable/disable only.

Providers own their upstream URLs; config supplies the secrets they need and
which providers are active. Modeled on openhands-nix config.py (pydantic
BaseSettings), restructured per-provider.

Design stage: shape only.
"""

from __future__ import annotations

from pydantic_settings import BaseSettings

from scooter_lib.settings import ScooterBaseSettings


class BrokerSettings(ScooterBaseSettings):
    # Auth
    token_audience: str = "agent-broker"
    sandbox_namespace: str = "agent-sandbox"

    # GitHub (App preferred; PAT fallback)
    github_app_id: str = ""
    github_app_private_key: str = ""
    github_app_installation_id: int = 0
    github_token: str = ""

    # Slack (static token)
    slack_bot_token: str = ""

    # --- Airtable (personal access token; http-proxy to api.airtable.com) ---
    # The broker's airtable provider proxies /airtable/* -> https://api.airtable.com
    # with the PAT injected, so the agent can read/write bases without seeing it.
    # Enabled iff the token is set. The upstream host is fixed (single-tenant SaaS),
    # so — unlike Grafana — there is no URL setting. The PAT's own scopes and base
    # grants are what bound the agent's access; the broker does not narrow them.
    airtable_token: str = ""

    # Test/diagnostic provider (the `test` whoami provider). OFF in prod.
    test_provider_enabled: bool = False

    # --- AWS permissions broker (broker/aws/) ------------------------------
    aws_enabled: bool = False
    aws_region: str = "us-east-1"
    aws_sts_external_id: str = "agent-permissions-broker"
    # The broker's own IRSA role ARN — the principal the dynamic roles trust.
    aws_broker_principal_arn: str = ""
    # Path to the account-registry JSON (a mounted ConfigMap): alias ->
    # {account_id, broker_role_arn, enabled, allowed_policy?, allowed_managed_policies?,
    #  region?, auto_approve_read_only?, auto_allowed_policy?, auto_allowed_managed_policies?}.
    # allowed_policy* = the CEILING (a glob superset a request must fall within).
    # auto_allowed_policy* = an OPT-IN sub-tier auto-granted with NO human approval — a
    # glob superset (fnmatch Action+Resource; managed-ARN fnmatch) of pre-approved grants,
    # e.g. sts:AssumeRole to arn:...:role/deploy-*. Checked after the ceiling, so it can
    # only auto-approve requests already in-bounds. Absent -> nothing auto-approves.
    aws_accounts_file: str = ""
    aws_role_ttl_hours: int = 12
    # Which identity claim authorizes an approver (must match how the FGA approver
    # tuples are seeded). "email" | "id" | "name". Default email.
    aws_approver_claim: str = "email"
    # Store DSN components (shared Postgres; SQLite default). Mirrors webhooks.
    aws_db_dsn: str = "sqlite+aiosqlite:////tmp/broker-aws.db"
    aws_db_host: str = "agent-shared-db.agent-manager.svc.cluster.local"
    aws_db_port: int = 5432
    aws_db_user: str = "webhooks"
    aws_db_password: str = ""
    aws_db_name: str = "broker"
    # SA usernames allowed to APPROVE/DENY (the agent-host relays the user's pick
    # after validating it in-conversation). CSV of
    # system:serviceaccount:{ns}:{name}. Default: the agent-host.
    aws_approver_service_accounts: str = ""
    # Notify the agent-host when a request is created so it raises the approval
    # interrupt. Empty = no notify (local/dev).
    aws_agent_host_url: str = ""
    # Retry budget for that notify. The request is already stored PENDING before we
    # notify, so a lost notify is recoverable (revive re-queries /aws/pending) — but
    # it costs the user a visible approval window until then, so retry the transient
    # cases (5xx / 503-not-yet-revivable / connect errors) a few times.
    aws_notify_attempts: int = 3
    # Base backoff between notify attempts (seconds); doubles each retry.
    aws_notify_backoff: float = 0.5

    # Sweep interval (seconds) for expired dynamic roles.
    aws_sweep_interval: int = 300

    # --- OpenFGA authorization (broker = the policy enforcement point) ------
    # Off by default -> NoopAuthorizer -> the broker behaves as before. When on,
    # the per-account approver gate on approve/deny is enforced via OpenFGA.
    fga_enabled: bool = False
    fga_api_url: str = ""             # e.g. http://openfga.agent-manager.svc:8080
    fga_store_id: str = ""
    fga_authorization_model_id: str = ""

    # --- Sandbox-adjacent settings --------------------------------------------
    # What the broker serves TO an existing sandbox. It does not provision them — see
    # core/app.py.
    #
    # A mounted directory of `.nix` files served as the deployment's DEFAULT modules
    # at GET /modules/default.tar.gz (fetched by the pod at re-converge, unauthed).
    # Empty/unset -> an empty tarball (the pod imports nothing).
    sandbox_default_modules_dir: str = ""

    # --- Module registry (broker/registry/) — the shareable-module catalog -----
    # The broker-side catalog: publish/list/download modules. Shares the broker DB
    # (module_registry table). Off by default (SQLite dev DSN); on = a real catalog.
    registry_enabled: bool = False
    registry_db_dsn: str = "sqlite+aiosqlite:////tmp/broker-registry.db"

    # --- Static shares (broker/shares/) — persistent static webpages -----------
    # Agents publish static bundles; the broker mints a UUID and serves them at
    # /s/<uuid>/. Shares the broker DB (static_shares + static_share_versions).
    # Off by default (SQLite dev DSN). `shares_public_base_url` is the external
    # origin used to build the returned share URL (e.g. https://scooter.example.com);
    # empty -> a relative /s/<uuid>/ URL.
    shares_enabled: bool = False
    shares_db_dsn: str = "sqlite+aiosqlite:////tmp/broker-shares.db"
    shares_public_base_url: str = ""
    # Who may frame a served share in an <iframe> (CSP frame-ancestors). Shares are
    # meant to be embedded ONLY inside the Scooter conversation UI, never arbitrary
    # external sites, so this is a strict allowlist. Default `'self'` = same origin
    # as the share; deployments where the UI is a different origin set this to the
    # UI origin(s), space-separated (e.g. "https://scooter.example.com"). A served
    # share also sends this so external embedding is blocked even if the value widens.
    shares_frame_ancestors: str = "'self'"

    port: int = 8080


# The process-wide settings snapshot. Most code reads `config.settings` directly.
# It's instantiated at import time, which is fine in prod (env is fixed before
# the app starts) but BRITTLE in tests: a test that sets an env var (e.g.
# TEST_PROVIDER_ENABLED) AFTER this module was first imported would otherwise be
# ignored. `refresh_settings()` re-reads the environment and updates this object
# IN PLACE so existing `from ..config import settings` references see the new
# values; `discover_providers()` calls it so provider factories always build
# against current env. See get_settings() for a fresh, non-mutating read.
settings = BrokerSettings()


def get_settings() -> BrokerSettings:
    """A fresh BrokerSettings read from the CURRENT environment (no caching)."""
    return BrokerSettings()


def refresh_settings() -> BrokerSettings:
    """Re-read env into the shared `settings` object in place, so module-level
    `settings` references (provider factories, etc.) pick up the current env.
    Returns the shared object. Idempotent; cheap."""
    fresh = BrokerSettings()
    settings.__dict__.update(fresh.__dict__)
    return settings
