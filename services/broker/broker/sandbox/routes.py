"""The sandbox lifecycle HTTP API — the broker as control plane.

The agent-host (a CONTROL caller, allowlisted in sandbox_control_service_accounts)
drives the pod lifecycle here instead of touching k8s itself:

    POST /sandbox/{conv}/ensure    -> create-or-resume, returns the pod ref
    POST /sandbox/{conv}/suspend
    POST /sandbox/{conv}/resume    -> apply the size spec, returns the pod ref
    POST /sandbox/{conv}/end
    GET  /sandbox                  -> list (reconcile)
    GET  /sandbox/{conv}/pod       -> ready-poll only (re-resolve podIP)
    PUT  /sandbox/{conv}/size      -> write the size spec
    GET  /sandbox/{conv}/size      -> read the size spec

Modules are NOT handled here: the pod pulls its module config as a tarball from the
broker (a root sandbox-os Nix module fetchTarballs it), so there's no per-conversation
module ConfigMap and no writeModule/ensureModuleMount.

Auth (two tiers):
  - lifecycle + module ops: CONTROL SA only (identity.service_account in the control
    list). A sandbox SA is 403.
  - size read/write: the CONTROL SA (any conv) OR the OWNING sandbox (its own conv) —
    so `scooter-rebuild limits` (in-pod, a sandbox SA) can set its own size.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Body, Depends, HTTPException, Path

from .config import default_resources
from .k8s import SandboxK8s
from .resources import InvalidResource, SandboxResources, render_resources, resolve_resources, validate_resources
from .store import SandboxSizeStore
from ..config import settings
from ..core.auth import authenticate
from ..core.types import Identity

logger = logging.getLogger(__name__)


def _is_control(identity: Identity) -> bool:
    control = {s.strip() for s in settings.sandbox_control_service_accounts.split(",") if s.strip()}
    return identity.service_account in control


def _require_control(identity: Identity) -> None:
    if not _is_control(identity):
        raise HTTPException(status_code=403, detail="not a sandbox-control caller")


def _require_control_or_owner(identity: Identity, conv: str) -> None:
    if _is_control(identity):
        return
    # A sandbox SA may only touch its OWN conversation's size.
    if identity.conversation_id and identity.conversation_id == conv:
        return
    raise HTTPException(status_code=403, detail="not authorized for this conversation")


def create_sandbox_router(k8s: SandboxK8s, store: SandboxSizeStore) -> APIRouter:
    router = APIRouter()

    async def _effective_size(conv: str) -> dict | None:
        """The rendered k8s resources block for a conv: its size spec, else the
        deployment default, else the platform default. None only if nothing renders."""
        spec = await store.get(conv)
        resolved = resolve_resources(spec, default_resources(settings))
        block = render_resources(resolved)
        return block or None

    @router.post("/sandbox/{conv}/ensure")
    async def ensure(conv: str = Path(...), body: dict = Body(default={}), identity: Identity = Depends(authenticate)):
        _require_control(identity)
        thread_id = body.get("threadId")
        # create() is 409-adopt-and-resume, so it doubles as ensure. Apply the size.
        ref = k8s.create(conv, thread_id, await _effective_size(conv))
        ready = k8s.ready_pod(ref.name)
        return {"name": ready.name, "namespace": ready.namespace, "podIP": ready.pod_ip, "running": ready.running}

    @router.post("/sandbox/{conv}/suspend")
    async def suspend(conv: str = Path(...), identity: Identity = Depends(authenticate)):
        _require_control(identity)
        k8s.suspend(conv)
        return {"suspended": True}

    @router.post("/sandbox/{conv}/resume")
    async def resume(conv: str = Path(...), identity: Identity = Depends(authenticate)):
        _require_control(identity)
        ref = k8s.resume(conv, await _effective_size(conv))
        ready = k8s.ready_pod(ref.name)
        return {"name": ready.name, "namespace": ready.namespace, "podIP": ready.pod_ip, "running": ready.running}

    @router.post("/sandbox/{conv}/end")
    async def end(conv: str = Path(...), identity: Identity = Depends(authenticate)):
        _require_control(identity)
        k8s.destroy(conv)
        return {"ended": True}

    @router.get("/sandbox")
    async def list_sandboxes(identity: Identity = Depends(authenticate)):
        _require_control(identity)
        return {"sandboxes": [{"name": r.name, "namespace": r.namespace, "running": r.running} for r in k8s.list_sandboxes()]}

    @router.get("/sandbox/{conv}/pod")
    async def pod(conv: str = Path(...), identity: Identity = Depends(authenticate)):
        _require_control(identity)
        ready = k8s.ready_pod(f"conv-{conv}")
        return {"name": ready.name, "namespace": ready.namespace, "podIP": ready.pod_ip, "running": ready.running}

    @router.put("/sandbox/{conv}/size")
    async def put_size(conv: str = Path(...), body: dict = Body(...), identity: Identity = Depends(authenticate)):
        _require_control_or_owner(identity, conv)
        try:
            spec = validate_resources(SandboxResources.from_dict(body))
        except InvalidResource as e:
            raise HTTPException(status_code=400, detail=f"{e} ({e.field})") from e
        await store.set(conv, spec)
        return {"size": spec.to_dict()}

    @router.get("/sandbox/{conv}/size")
    async def get_size(conv: str = Path(...), identity: Identity = Depends(authenticate)):
        _require_control_or_owner(identity, conv)
        spec = await store.get(conv)
        return {"size": spec.to_dict() if spec else None}

    return router
