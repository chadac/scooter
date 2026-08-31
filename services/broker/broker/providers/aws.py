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
from ..logging_config import format_error
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
        # Finding #3: returning {} here makes `enabled = aws_enabled and bool(registry)`
        # compute False, so a CONFIGURED-but-broken file (bad path / perms / malformed
        # JSON) silently disables the AWS provider — the broker boots "healthy" and
        # every request gets a misleading 503, indistinguishable from a deliberately
        # disabled provider. If the operator explicitly enabled AWS, fail fast instead.
        logger.exception(
            "failed to read aws_accounts_file",
            extra={"path": settings.aws_accounts_file, "aws_enabled": settings.aws_enabled},
        )
        if settings.aws_enabled:
            raise
        return {}


async def notify_host(req) -> None:
    """Tell the agent-host a request is pending so it raises the approval
    interrupt in the conversation.

    The request is ALREADY stored PENDING before this runs, so the broker never
    loses it — but a dropped notify costs the user a visible Approve window until
    something re-queries /aws/pending (the agent-host does that on revive). So:

      * CHECK the status. The previous version did `await client.post(...)` and
        discarded the response, so a 404 (unknown conversation) or a 503 (the host
        couldn't activate the conversation to raise the interrupt) vanished with no
        log line anywhere — the approval simply never appeared and nothing said why.
      * RETRY the transient cases. 5xx/503 and connect/timeout errors are retried
        with exponential backoff; the host's raise is idempotent (it keys on the
        request id, and the UI folds interrupts into a map by id), so a duplicate
        delivery is a no-op rather than a second approval panel.
      * DON'T retry a 4xx other than 408/429 — a 404/400 is a permanent addressing
        or payload problem that will fail identically every time; log it loudly and
        stop, so a misconfiguration is visible instead of silently hammered.

    Still best-effort overall: this never raises to the caller (PermissionService
    catches too), because a notify failure must not fail an already-stored request.
    """
    if not settings.aws_agent_host_url:
        return
    import httpx

    # The broker addresses the conversation by the SHORT id parsed from the sandbox
    # SA name (core/auth.py _SA_PATTERN: `sandbox-{shortId}`); the agent-host resolves
    # it via getByShortId (which also hydrates a suspended/evicted conversation).
    url = f"{settings.aws_agent_host_url.rstrip('/')}/conversations/{req.conversation_id}/aws-request"
    payload = {
        "request_id": req.request_id,
        "target_account": req.target_account,
        "risk_level": req.risk_level.value,
        "policy_summary": req.policy_summary,
        "justification": req.justification,
    }

    attempts = max(1, settings.aws_notify_attempts)
    delay = max(0.0, settings.aws_notify_backoff)
    for attempt in range(1, attempts + 1):
        last = attempt == attempts
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload)
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
            # 4xx that won't change on a retry -> permanent; stop and say so.
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
        await notify_host(req)

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
            approver_claim=settings.aws_approver_claim,
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
                    logger.exception(
                        "failed seeding approver tuple",
                        extra={"approver": approver, "account_alias": alias},
                    )
        if settings.fga_enabled:
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
