"""AWS permissions provider: dynamic, approval-gated AWS access.

Builds the PermissionService (store plus boto3 IAM provisioner), wires it into the
aws-permissions transport and registers the startup hooks; off unless aws_enabled
and an account registry are configured. See docs/AWS_PERMISSIONS_BROKER.md.
"""

from __future__ import annotations

import asyncio
import json
import logging

from .iam import IamProvisioner
from .models import APPROVAL_KIND, approval_data, approval_message
from .service import PermissionService, ServiceConfig
from .store import PermissionStore
from .config import settings
from .objects import aws_account_object
from . import rules
from scooter_broker_lib.authz import NoopAuthorizer, user_object
from scooter_broker_lib.autolink import router_headers
from scooter_broker_lib.context import BrokerContext
from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.types import Provider
from scooter_lib.logging_config import format_error
from .permissions_transport import AwsPermissions

logger = logging.getLogger(__name__)

# Test seam: a fake IamProvisioner that bypasses boto3.
_iam_override = None


def _load_registry() -> dict[str, dict]:
    if not settings.aws_accounts_file:
        return {}
    try:
        with open(settings.aws_accounts_file) as f:
            return json.load(f)
    except Exception:
        # A configured-but-broken file must fail fast rather than silently disable the provider.
        logger.exception(
            "failed to read aws_accounts_file",
            extra={"path": settings.aws_accounts_file, "aws_enabled": settings.aws_enabled},
        )
        if settings.aws_enabled:
            raise
        return {}


async def notify_host(req) -> None:
    """Tell the agent-host a request is pending so it raises the approval interrupt.

    Transient failures (5xx, 408/429, connect errors) are retried with backoff
    because the host's raise is idempotent; other 4xx are logged and not retried.
    Never raises, since the request is already stored pending and a dropped notify
    only delays the approval window until the host re-queries /aws/pending.
    """
    if not settings.aws_agent_host_url:
        return
    import httpx

    # Addressed by the short id from the sandbox SA name.
    url = (
        f"{settings.aws_agent_host_url.rstrip('/')}"
        f"/conversations/{req.conversation_id}/approvals/aws"
    )
    payload = {
        "request_id": req.request_id,
        "message": approval_message(req),
        "kind": APPROVAL_KIND,
        "data": approval_data(req),
    }

    attempts = max(1, settings.aws_notify_attempts)
    delay = max(0.0, settings.aws_notify_backoff)
    for attempt in range(1, attempts + 1):
        last = attempt == attempts
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload, headers=router_headers())
        except httpx.HTTPError as e:
            if last:
                logger.error(
                    "notify errored; giving up (request stays PENDING, host re-queries /aws/pending on revive)",
                    extra={
                        "conversation_id": req.conversation_id,
                        "request_id": req.request_id,
                        "url": url,
                        "attempt": attempt,
                        "attempts": attempts,
                        "error": format_error(e),
                    },
                )
                return
            logger.warning(
                "notify attempt errored; retrying",
                extra={
                    "conversation_id": req.conversation_id,
                    "request_id": req.request_id,
                    "url": url,
                    "attempt": attempt,
                    "attempts": attempts,
                    "retry_in_ms": int(delay * 1000),
                    "error": format_error(e),
                },
            )
        else:
            if resp.status_code < 300:
                logger.info(
                    "notify raised approval interrupt",
                    extra={
                        "conversation_id": req.conversation_id,
                        "request_id": req.request_id,
                        "status": resp.status_code,
                        "attempt": attempt,
                    },
                )
                return
            if 400 <= resp.status_code < 500 and resp.status_code not in (408, 429):
                logger.error(
                    "notify returned a permanent error; not retrying (unknown conversation or bad payload)",
                    extra={
                        "conversation_id": req.conversation_id,
                        "request_id": req.request_id,
                        "url": url,
                        "status": resp.status_code,
                        "attempt": attempt,
                        "body": resp.text[:500],
                    },
                )
                return
            if last:
                logger.error(
                    "notify failed; giving up (request stays PENDING, host re-queries /aws/pending on revive)",
                    extra={
                        "conversation_id": req.conversation_id,
                        "request_id": req.request_id,
                        "url": url,
                        "status": resp.status_code,
                        "attempt": attempt,
                        "attempts": attempts,
                        "body": resp.text[:500],
                    },
                )
                return
            logger.warning(
                "notify returned a transient error; retrying",
                extra={
                    "conversation_id": req.conversation_id,
                    "request_id": req.request_id,
                    "url": url,
                    "status": resp.status_code,
                    "attempt": attempt,
                    "attempts": attempts,
                    "retry_in_ms": int(delay * 1000),
                },
            )
        await asyncio.sleep(delay)
        delay *= 2


async def withdraw_host(req) -> None:
    """Tell the agent-host to drop a superseded request's approval interrupt.

    One attempt and never raises: a card left behind answers with a harmless 409.
    """
    if not settings.aws_agent_host_url:
        return
    import httpx

    url = (
        f"{settings.aws_agent_host_url.rstrip('/')}"
        f"/conversations/{req.conversation_id}/approvals/aws/{req.request_id}"
    )
    extra = {"conversation_id": req.conversation_id, "request_id": req.request_id}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.delete(url, headers=router_headers())
    except httpx.HTTPError as e:
        logger.warning("withdraw errored; card stays up", extra={**extra, "error": format_error(e)})
        return
    if resp.status_code >= 300:
        logger.warning(
            "withdraw refused; card stays up",
            extra={**extra, "status": resp.status_code, "body": resp.text[:500]},
        )
        return
    logger.info("withdrew approval interrupt", extra={**extra, "status": resp.status_code})


@register_provider
def aws(ctx: BrokerContext) -> Provider:
    registry = _load_registry()
    enabled = settings.aws_enabled and bool(registry)

    transport = AwsPermissions()

    if not enabled:
        # Mounted but inert: routes return 503 while set_service is unset.
        return Provider(name="aws", transports=[transport], enabled=False)

    store = PermissionStore(ctx.contrib_store_config("aws"))
    iam = _iam_override or IamProvisioner(
        region=settings.aws_region,
        external_id=settings.aws_sts_external_id,
        account_registry=registry,
    )
    async def _notify_host(req) -> None:
        await notify_host(req)

    async def _withdraw_host(req) -> None:
        await withdraw_host(req)

    # The per-account approver gate on approve/deny, built by the app.
    authorizer = ctx.authorizer

    service = PermissionService(
        store=store,
        iam=iam,
        account_registry=registry,
        config=ServiceConfig(
            role_ttl_hours=settings.aws_role_ttl_hours,
            broker_principal_arn=settings.aws_broker_principal_arn,
            approver_claim=settings.aws_approver_claim,
        ),
        on_request=_notify_host,
        on_withdraw=_withdraw_host,
        authorizer=authorizer,
    )
    # approve/deny require an approver identity, which auth recognizes via approver_service_accounts.
    transport.set_service(service, is_admin=lambda identity: identity.is_approver)

    _sweep_task: list[asyncio.Task] = []

    async def seed_approver_tuples() -> None:
        """Idempotently seed FGA approver tuples for accounts and rules."""
        for alias, acct in registry.items():
            tuples = [(a, aws_account_object(alias)) for a in acct.get("approvers", []) or []]
            try:
                tuples += rules.rule_approver_tuples(alias, rules.parse_rules(acct.get("approval_rules") or []))
            except ValueError:
                logger.exception("malformed approval_rules; not seeding its rules", extra={"account_alias": alias})
            for approver, obj in tuples:
                try:
                    await authorizer.grant(user=user_object(approver), relation="approver", obj=obj)
                except Exception:
                    logger.exception(
                        "failed seeding approver tuple",
                        extra={"approver": approver, "account_alias": alias, "object": obj},
                    )
        # Under NoopAuthorizer grant() does nothing, so the log line would be a lie.
        if not isinstance(authorizer, NoopAuthorizer):
            logger.info(
                "seeded approver tuples from the account registry",
                extra={"account_count": len(registry)},
            )

    async def on_startup() -> None:
        await seed_approver_tuples()
        async def sweep_loop() -> None:
            while True:
                await asyncio.sleep(settings.aws_sweep_interval)
                try:
                    swept = await service.sweep_expired()
                    if swept:
                        logger.info(
                            "swept expired roles",
                            extra={"swept_count": len(swept), "request_ids": swept},
                        )
                except Exception:
                    logger.exception(
                        "expiry sweep failed",
                        extra={"sweep_interval_s": settings.aws_sweep_interval},
                    )
        _sweep_task.append(asyncio.create_task(sweep_loop()))
        logger.info(
            "provider ready",
            extra={"account_count": len(registry)},
        )

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
