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
from ..core.authz import authorizer_from_settings, aws_account_object, user_object
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
    async def _notify_host(req) -> None:
        """Tell the agent-host a request is pending so it raises the approval
        interrupt in the conversation. Best-effort."""
        if not settings.aws_agent_host_url:
            return
        import httpx

        url = f"{settings.aws_agent_host_url.rstrip('/')}/conversations/{req.conversation_id}/aws-request"
        payload = {
            "request_id": req.request_id,
            "target_account": req.target_account,
            "risk_level": req.risk_level.value,
            "policy_summary": req.policy_summary,
            "justification": req.justification,
        }
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(url, json=payload)

    # Authorization (the broker's enforcement point): per-account approver gate
    # on approve/deny. Off (default) -> NoopAuthorizer -> today's behavior.
    authorizer = authorizer_from_settings(settings)

    service = PermissionService(
        store=store,
        iam=iam,
        account_registry=registry,
        config=ServiceConfig(
            role_ttl_hours=settings.aws_role_ttl_hours,
            broker_principal_arn=settings.aws_broker_principal_arn,
        ),
        on_request=_notify_host,
        authorizer=authorizer,
    )
    # Admin seam: approve/deny require an APPROVER identity (the agent-host
    # relaying the user's pick — recognized by auth via aws_approver_service_accounts).
    transport.set_service(service, is_admin=lambda identity: identity.is_approver)

    _sweep_task: list[asyncio.Task] = []

    async def seed_approver_tuples() -> None:
        """Seed OpenFGA approver tuples from the account registry's per-account
        `approvers` list (deploy config). Idempotent (grant of an existing tuple
        is a no-op). No-op when FGA is off (NoopAuthorizer.grant does nothing)."""
        for alias, acct in registry.items():
            for approver in acct.get("approvers", []) or []:
                try:
                    await authorizer.grant(
                        user=user_object(approver),
                        relation="approver",
                        obj=aws_account_object(alias),
                    )
                except Exception:
                    logger.exception("failed seeding approver %s for %s", approver, alias)
        if settings.fga_enabled:
            logger.info("seeded AWS approver tuples from the account registry")

    async def on_startup() -> None:
        await store.init()
        await seed_approver_tuples()
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
