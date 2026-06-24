"""AWS permissions provider — dynamic, approval-gated AWS access.

Builds the PermissionService (Postgres/SQLite store + boto3 IAM provisioner),
wires it into the aws-permissions transport, and registers async startup hooks
(open the store, start the expired-role sweep). Off unless aws_enabled + an
account registry are configured. See docs/AWS_PERMISSIONS_BROKER.md.
"""

from __future__ import annotations

import asyncio
import json
import logging

from ..aws.iam import IamProvisioner
from ..aws.service import PermissionService, ServiceConfig
from ..aws.store import PermissionStore, StoreConfig
from ..config import settings
from ..core.registry import register_provider
from ..core.types import Provider
from ..transports.aws_permissions import AwsPermissions

logger = logging.getLogger(__name__)

# Test seam: set to a fake IamProvisioner to bypass real boto3 (tests only).
_iam_override = None


def _load_registry() -> dict[str, dict]:
    if not settings.aws_accounts_file:
        return {}
    try:
        with open(settings.aws_accounts_file) as f:
            return json.load(f)
    except Exception:
        logger.exception("failed to read aws_accounts_file %s", settings.aws_accounts_file)
        return {}


@register_provider
def aws() -> Provider:
    registry = _load_registry()
    enabled = settings.aws_enabled and bool(registry)

    transport = AwsPermissions()

    if not enabled:
        # Mounted but inert: routes return 503 until configured (set_service unset).
        return Provider(name="aws", transports=[transport], enabled=False)

    store = PermissionStore(
        StoreConfig(
            dsn=settings.aws_db_dsn,
            db_host=settings.aws_db_host,
            db_port=settings.aws_db_port,
            db_user=settings.aws_db_user,
            db_password=settings.aws_db_password,
            db_name=settings.aws_db_name,
        )
    )
    iam = _iam_override or IamProvisioner(
        region=settings.aws_region,
        external_id=settings.aws_sts_external_id,
        account_registry=registry,
    )
    service = PermissionService(
        store=store,
        iam=iam,
        account_registry=registry,
        config=ServiceConfig(
            role_ttl_hours=settings.aws_role_ttl_hours,
            broker_principal_arn=settings.aws_broker_principal_arn,
        ),
    )
    # Admin seam: default allows any authenticated caller (in-conversation flow
    # trusts the conversation user). A deployer can tighten this later.
    transport.set_service(service, is_admin=None)

    _sweep_task: list[asyncio.Task] = []

    async def on_startup() -> None:
        await store.init()
        async def sweep_loop() -> None:
            while True:
                await asyncio.sleep(settings.aws_sweep_interval)
                try:
                    swept = await service.sweep_expired()
                    if swept:
                        logger.info("swept %d expired AWS roles: %s", len(swept), swept)
                except Exception:
                    logger.exception("AWS expiry sweep failed")
        _sweep_task.append(asyncio.create_task(sweep_loop()))
        logger.info("AWS permissions provider ready (%d accounts)", len(registry))

    async def on_shutdown() -> None:
        for t in _sweep_task:
            t.cancel()

    return Provider(
        name="aws",
        transports=[transport],
        enabled=True,
        on_startup=on_startup,
        on_shutdown=on_shutdown,
    )
