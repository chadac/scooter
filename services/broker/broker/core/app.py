"""App factory — assembles the broker from discovered provider modules.

The core is generic: discover providers, and for each enabled one, mount every
transport's routes under the provider's prefix. No per-provider code here.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .auth import authenticate
from .autolink import Link, create_link, list_links
from .registry import discover_providers
from .types import Identity
from .scope import DefaultMethodScopeClassifier
from .policy import Decision, DeclarativePolicy, Policy
from .authz_provider import AuthzResult, InboundRequest
from .audit import AuditEvent, AuditSink, JsonLogSink, emit_best_effort
from .approval import ApprovalStore, InMemoryApprovalStore, PendingApproval
from ..config import settings
from ..logging_config import configure_logging

logger = logging.getLogger(__name__)


def create_app(
    policy: Policy | None = None,
    audit: AuditSink | None = None,
    approvals: ApprovalStore | None = None,
    on_approval_request=None,  # optional (PendingApproval) -> None|await: notify the host
) -> FastAPI:
    providers = list(discover_providers())

    # The authz + audit layer. Injectable for tests/deployers; the defaults are
    # allow-everything (+audit) and the JSON-log sink — so mounting this middleware
    # is a no-op for existing behavior until a deployer supplies a real policy.
    policy = policy if policy is not None else DeclarativePolicy.from_config(_load_policy_config())
    audit = audit if audit is not None else JsonLogSink()
    approvals = approvals if approvals is not None else InMemoryApprovalStore()

    # provider name -> its authorizer + scope classifier, keyed by mount prefix so
    # the middleware can look them up from the request path alone.
    by_name = {p.name: p for p in providers}

    async def _notify_approval(rec: PendingApproval) -> None:
        if on_approval_request is None:
            return
        res = on_approval_request(rec)
        if hasattr(res, "__await__"):
            await res

    # Sandbox lifecycle (the broker as control plane). Built when enabled; its size
    # store is init'd in the lifespan and its router mounted top-level (like /link).
    sandbox_store = None
    sandbox_router = None
    if settings.sandbox_lifecycle_enabled:
        from ..sandbox.config import deploy_config, size_store_config
        from ..sandbox.k8s import SandboxK8s
        from ..sandbox.routes import create_sandbox_router
        from ..sandbox.store import SandboxSizeStore

        sandbox_store = SandboxSizeStore(size_store_config(settings))
        sandbox_router = create_sandbox_router(SandboxK8s(deploy_config(settings)), sandbox_store)

    # Module registry (broker/registry/) — the shareable-module catalog. Built when
    # enabled; its store is init'd in the lifespan + its router mounted top-level.
    registry_store = None
    registry_router = None
    if settings.registry_enabled:
        from ..aws.store import StoreConfig
        from ..registry.routes import create_registry_router
        from ..registry.store import ModuleRegistryStore

        # Share the AWS DB components (same shared Postgres `broker` DB); the SQLite
        # registry_db_dsn is the dev default when no db_password is set.
        registry_store = ModuleRegistryStore(StoreConfig(
            dsn=settings.registry_db_dsn,
            db_host=settings.aws_db_host, db_port=settings.aws_db_port,
            db_user=settings.aws_db_user, db_password=settings.aws_db_password,
            db_name=settings.aws_db_name,
        ))
        registry_router = create_registry_router(registry_store)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Run providers' async startup hooks (e.g. open a DB, start a sweep).
        for p in providers:
            if p.on_startup is not None:
                await p.on_startup()
        yield
        for p in providers:
            if p.on_shutdown is not None:
                await p.on_shutdown()

    app = FastAPI(title="kubenix-agent-manager broker", lifespan=lifespan)

    if sandbox_router is not None:
        app.include_router(sandbox_router)

    if registry_router is not None:
        app.include_router(registry_router)

    # Deployment-default modules — GET /modules/default.tar.gz, UNAUTHENTICATED (the
    # pod fetches at boot; module Nix isn't a secret). Always mounted; serves an empty
    # tarball when no default-modules dir is configured.
    from .default_modules import create_default_modules_router

    app.include_router(create_default_modules_router())

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    # Conversation links — the agent-facing complement to the auto-link injector.
    # The injector auto-links PRs/MRs/issues created THROUGH the proxy; this lets an
    # agent explicitly attach a link the injector missed (e.g. created via the gh/glab
    # CLI, or a resource type not watched) and list what's currently linked. The
    # conversation is taken from the caller's SA token — never a request field — so an
    # agent can only touch its OWN conversation's links. The sandbox reaches these via
    # `agent-broker link ...` (see the scooter-links skill).
    @app.post("/link", status_code=201)
    async def attach_link(
        body: dict, identity: Identity = Depends(authenticate)
    ) -> dict[str, str]:
        url = (body.get("url") or "").strip()
        resource_type = (body.get("resourceType") or body.get("type") or "").strip()
        source = (body.get("source") or "").strip()
        if not url or not resource_type or not source:
            raise HTTPException(status_code=400, detail="source, resourceType, and url are required")
        link = Link(source=source, resource_type=resource_type, url=url, title=body.get("title"))
        try:
            await create_link(settings.agent_host_url, identity.conversation_id, link)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"agent-host link failed: {e}") from e
        except RuntimeError as e:
            raise HTTPException(status_code=409, detail=str(e)) from e
        return {"status": "linked"}

    @app.get("/link")
    async def get_links(identity: Identity = Depends(authenticate)) -> dict[str, list]:
        try:
            links = await list_links(settings.agent_host_url, identity.conversation_id)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"agent-host list-links failed: {e}") from e
        return {"links": links}

    # --- Generic approval answer routes --------------------------------------
    # A human's approve/deny of a pending approval (the agent-host relays the
    # user's pick). Approver-gated: only a non-sandbox approver SA may answer (the
    # same identity class that answers AWS approvals). Not a provider call, so NOT
    # behind the enforcement middleware.
    @app.post("/approval/{approval_id}/approve")
    async def approve_request(approval_id: str, identity: Identity = Depends(authenticate)):
        if not identity.is_approver:
            raise HTTPException(status_code=403, detail="not an approver")
        try:
            rec = await approvals.approve(approval_id, approver=identity.service_account)
        except KeyError:
            raise HTTPException(status_code=404, detail="unknown approval") from None
        except Exception as e:  # a provider on_approved side-effect failed (e.g. STS)
            raise HTTPException(status_code=502, detail=f"approve side-effect failed: {e}") from e
        return {"status": rec.status, "approval_id": rec.id}

    @app.post("/approval/{approval_id}/deny")
    async def deny_request(approval_id: str, body: dict | None = None, identity: Identity = Depends(authenticate)):
        if not identity.is_approver:
            raise HTTPException(status_code=403, detail="not an approver")
        reason = (body or {}).get("reason") if isinstance(body, dict) else None
        try:
            rec = await approvals.deny(approval_id, approver=identity.service_account, reason=reason)
        except KeyError:
            raise HTTPException(status_code=404, detail="unknown approval") from None
        return {"status": rec.status, "approval_id": rec.id}

    # --- The core-enforced authz + audit pipeline ----------------------------
    # An HTTP middleware wraps EVERY /<provider>/... request so a provider —
    # including a 3rd-party one — physically cannot skip authz or audit:
    #   authenticate -> classify/authorize -> (audit decision) -> handler -> (audit result)
    # Non-provider routes (/health, /link, sandbox, registry) are NOT gated.
    @app.middleware("http")
    async def enforce(request: Request, call_next):
        prefix = request.url.path.lstrip("/").split("/", 1)[0]
        provider = by_name.get(prefix)
        if provider is None:
            return await call_next(request)  # not a provider call — pass through

        # Authenticate at the middleware layer. Honor a dependency_overrides entry
        # (how tests inject a fake identity) since a middleware can't use Depends.
        # An override matches the DEPENDENCY's result shape `() -> Identity` (no
        # Request arg), whereas the real authenticate takes the Request — so call
        # the override with no args, the real resolver with the request.
        override = app.dependency_overrides.get(authenticate)
        try:
            if override is not None:
                identity = override()
                if hasattr(identity, "__await__"):
                    identity = await identity
            else:
                identity = await authenticate(request)
        except HTTPException as e:
            return JSONResponse({"detail": e.detail}, status_code=e.status_code)

        # Buffer the body so scope_for/authorize can read it AND the handler still
        # gets it (Starlette caches request._body once read).
        body = await request.body()

        # Two-tier authorization: a provider's custom authorizer (content-dependent
        # — AWS/email), else the generic scope_for -> declarative policy path.
        authorizer = getattr(provider, "authorizer", None)
        if authorizer is not None:
            policy_slice = _policy_slice_for(provider.name)
            result: AuthzResult = await authorizer.authorize(
                identity, InboundRequest(method=request.method, path=request.url.path, body=body), policy_slice
            )
            decision, scope_str, detail = result.decision, result.scope, result.detail
            summary = result.summary
        else:
            classifier = getattr(provider, "scope_classifier", None) or DefaultMethodScopeClassifier(
                provider=provider.name
            )
            scope = classifier.scope_for(request.method, request.url.path, body)
            decision = await policy.decide(identity, scope)
            scope_str, detail, summary = str(scope), None, str(scope)

        async def _audit(decision_label: str, upstream_status: int | None) -> bool:
            """Emit the audit event. Fail-closed for a `required` sink (return
            False -> the caller 503s); best-effort otherwise (always True)."""
            event = AuditEvent(
                conversation_id=identity.conversation_id,
                provider=provider.name,
                action="call",
                scope=scope_str,
                decision=decision_label,
                method=request.method,
                path=request.url.path,
                upstream_status=upstream_status,
                attributes=detail or {},
            )
            if getattr(audit, "required", False):
                try:
                    await audit.record(event)
                except Exception:  # noqa: BLE001 — required sink down -> fail closed
                    return False
            else:
                await emit_best_effort(audit, event)
            return True

        if decision is Decision.DENY:
            if not await _audit("denied", None):
                return JSONResponse({"detail": "audit unavailable"}, status_code=503)
            return JSONResponse({"detail": f"denied by policy: {scope_str}"}, status_code=403)

        if decision is Decision.REQUIRE_APPROVAL:
            # ASYNC approval (matches AWS's shape — no blocked connection). A RETRY
            # after approval finds an approved record for this (conversation, scope)
            # and falls through to the handler; a denied record 403s; otherwise
            # create a pending record, notify the host (raise the interrupt), 202.
            existing = approvals.find_approved(
                conversation_id=identity.conversation_id, scope=scope_str
            )
            if existing is None:
                # Any denied record for this exact scope means the human said no.
                denied = _find_denied(approvals, identity.conversation_id, scope_str)
                if denied is not None:
                    await _audit("denied", None)
                    return JSONResponse(
                        {"detail": f"denied by approver: {denied.deny_reason or scope_str}"},
                        status_code=403,
                    )
                rec = approvals.create(
                    conversation_id=identity.conversation_id,
                    provider=provider.name,
                    scope=scope_str,
                    summary=summary or scope_str,
                    detail=detail or {},
                )
                # Wire the mounting provider's approve-time side-effect for this record.
                on_approved = getattr(provider, "on_approved", None)
                if on_approved is not None and hasattr(approvals, "set_on_approved"):
                    approvals.set_on_approved(on_approved)
                await _notify_approval(rec)
                await _audit("pending", None)
                return JSONResponse(
                    {"approval_id": rec.id, "status": "pending", "summary": rec.summary},
                    status_code=202,
                )
            # Approved on a retry — fall through to run the handler (audited allow).

        # ALLOW (or an approved REQUIRE_APPROVAL retry): audit BEFORE running the
        # handler (fail-closed for a required sink), then run it.
        if not await _audit("allow", None):
            return JSONResponse({"detail": "audit unavailable"}, status_code=503)
        return await call_next(request)

    for provider in providers:
        for transport in provider.transports:
            app.include_router(
                transport.routes(provider, authed=authenticate),
                prefix=f"/{provider.name}",
            )
        logger.info(
            "mounted provider",
            extra={
                "provider": provider.name,
                "transports": [t.name for t in provider.transports],
            },
        )

    return app


def _find_denied(approvals, conversation_id: str, scope: str):
    """A denied approval for this exact (conversation, scope), if any — so a retry
    after a deny 403s instead of re-prompting. Best-effort: only the in-memory
    store exposes iteration; a custom store without it just re-prompts (safe)."""
    by_id = getattr(approvals, "_by_id", None)
    if not by_id:
        return None
    for rec in by_id.values():
        if rec.status == "denied" and rec.conversation_id == conversation_id and rec.scope == scope:
            return rec
    return None


def _load_policy_config() -> dict:
    """Load the deployer's authz policy config (a mounted YAML/JSON file named by
    settings.authz_policy_file). Absent/empty -> {} -> default-allow (no
    behavior change). Malformed -> raise (fail loudly, don't silently allow)."""
    path = getattr(settings, "authz_policy_file", "") or ""
    if not path:
        return {}
    import json
    import os

    if not os.path.exists(path):
        return {}
    with open(path) as f:
        text = f.read().strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        import yaml  # optional; policy files are usually YAML

        return yaml.safe_load(text) or {}


# The full policy config keyed by provider name; the slice passed into a
# provider's custom authorizer (constraints owned by the deployer, enforced by
# the provider). Loaded once alongside the policy.
_POLICY_CONFIG_CACHE: dict | None = None


def _policy_slice_for(provider_name: str) -> dict:
    global _POLICY_CONFIG_CACHE
    if _POLICY_CONFIG_CACHE is None:
        _POLICY_CONFIG_CACHE = _load_policy_config()
    return _POLICY_CONFIG_CACHE.get(provider_name, {}) if isinstance(_POLICY_CONFIG_CACHE, dict) else {}


def main() -> None:
    import uvicorn

    # Structured JSON logs (one object per line) — replaces logging.basicConfig.
    # Installed BEFORE create_app() so provider discovery's own lines are captured
    # in the same shape, and before uvicorn.run() so uvicorn's loggers inherit the
    # root handler instead of installing their own prose formatter.
    configure_logging("broker")
    uvicorn.run(
        create_app(),
        host="0.0.0.0",
        port=settings.port,
        log_config=None,  # keep OUR root handler; uvicorn's default dictConfig replaces it
    )
