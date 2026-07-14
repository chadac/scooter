"""Build the sandbox DeployConfig + size-store StoreConfig from BrokerSettings.

The deployment provisioning config that used to be passed to the agent-host's
K8sProvisioner (K8sProvisionerOptions) is now broker-owned via env — this maps
BrokerSettings -> DeployConfig, and assembles the size store's DSN from the shared
AWS DB components (same Postgres instance, `broker` DB).
"""

from __future__ import annotations

import json
import logging

from .manifest import DeployConfig
from .resources import SandboxResources, validate_resources
from ..aws.store import StoreConfig
from ..config import BrokerSettings

logger = logging.getLogger(__name__)


def _csv(v: str) -> list[str]:
    return [s.strip() for s in v.split(",") if s.strip()]


def deploy_config(settings: BrokerSettings) -> DeployConfig:
    extra_env: list[dict] = []
    if settings.sandbox_extra_env_json.strip():
        try:
            extra_env = json.loads(settings.sandbox_extra_env_json)
        except json.JSONDecodeError as e:
            logger.error("SANDBOX_EXTRA_ENV_JSON is invalid — ignoring: %s", e)
    return DeployConfig(
        namespace=settings.sandbox_namespace,
        sandbox_image=settings.sandbox_image,
        workspace_storage=settings.sandbox_workspace_storage,
        broker_audience=settings.token_audience,
        overlay_store=settings.sandbox_overlay_store,
        overlay_storage=settings.sandbox_overlay_storage,
        systemd_image=settings.sandbox_systemd_image,
        aws_accounts_configmap=settings.sandbox_aws_accounts_configmap or None,
        scooter_configmap=settings.sandbox_scooter_configmap or None,
        config_files_configmap=settings.sandbox_config_files_configmap or None,
        extra_token_audiences=_csv(settings.sandbox_token_audiences),
        extra_env=extra_env,
        public_url=settings.sandbox_public_url or None,
    )


def default_resources(settings: BrokerSettings) -> SandboxResources | None:
    """The deployment default size (SANDBOX_DEFAULT_RESOURCES_JSON). None -> the
    platform default. A malformed value FAILS LOUDLY (a wrong default size is a
    real misconfiguration, not something to swallow)."""
    raw = settings.sandbox_default_resources_json.strip()
    if not raw:
        return None
    return validate_resources(SandboxResources.from_dict(json.loads(raw)))


def size_store_config(settings: BrokerSettings) -> StoreConfig:
    """The size store shares the AWS DB components (same shared Postgres, `broker`
    DB). An explicit sandbox_db_dsn (SQLite dev default) wins when no db_password."""
    return StoreConfig(
        dsn=settings.sandbox_db_dsn,
        db_host=settings.aws_db_host,
        db_port=settings.aws_db_port,
        db_user=settings.aws_db_user,
        db_password=settings.aws_db_password,
        db_name=settings.aws_db_name,
    )
