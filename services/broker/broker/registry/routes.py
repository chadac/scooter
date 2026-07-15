"""The module registry HTTP API — the broker-side catalog.

    GET  /modules.tar.gz?ids=a,b   download (UNAUTHENTICATED) — a gzipped tar of
                                    <id>/<filename> for each requested module, which
                                    registry-modules.nix fetchTarballs + imports.
    GET  /modules[?q=]             list VISIBLE modules (authed): own private + all
                                    public, searchable. Metadata only (no file blob).
    GET  /modules/{id}             one module's metadata + files (authed; visibility-gated).
    POST /modules                  publish/create (authed): owner = caller's conversation.

Download is open (Nix isn't a secret); the CATALOG (list + get-with-files) is
visibility-gated. Owner = the publishing conversation's id (the broker has no
email/user; #127 human-user resolution is a follow-up).
"""

from __future__ import annotations

import gzip
import io
import logging
import tarfile
from typing import Callable

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from fastapi.responses import Response

from .store import Module, ModuleRegistryStore
from ..core.auth import authenticate
from ..core.types import Identity

logger = logging.getLogger(__name__)

_VALID_VISIBILITY = {"private", "public"}


def _build_tarball(entries: dict[str, str]) -> bytes:
    """Gzipped tar of {path: content} at fixed mtime (deterministic fetchTarball hash)."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for path, content in entries.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name=path)
            info.size = len(data)
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


def _visible_to(m: Module, viewer: str) -> bool:
    return m.visibility == "public" or m.owner == viewer


def create_registry_router(store: ModuleRegistryStore, *, now: Callable[[], str] = lambda: "") -> APIRouter:
    router = APIRouter()

    # --- download (unauthenticated) -----------------------------------------
    @router.get("/modules.tar.gz")
    async def download(ids: str = Query(..., description="comma-separated module ids")) -> Response:
        id_list = [i.strip() for i in ids.split(",") if i.strip()]
        if not id_list:
            raise HTTPException(status_code=400, detail="ids is required")
        entries: dict[str, str] = {}
        for module_id in id_list:
            files = await store.get_files(module_id)
            if files is None:
                raise HTTPException(status_code=404, detail=f"module not found: {module_id}")
            for fname, content in files.items():
                # Reject a traversal in a stored filename (defensive).
                if "/" in fname or fname in ("..", "."):
                    raise HTTPException(status_code=500, detail=f"bad filename in module {module_id}")
                entries[f"{module_id}/{fname}"] = content
        return Response(content=_build_tarball(entries), media_type="application/gzip")

    # --- catalog (authenticated, visibility-gated) --------------------------
    @router.get("/modules")
    async def list_modules(q: str = Query(default=""), identity: Identity = Depends(authenticate)):
        viewer = identity.conversation_id
        mods = await store.list_visible(viewer, q)
        return {"modules": [m.summary() for m in mods]}

    @router.get("/modules/{module_id}")
    async def get_module(module_id: str, identity: Identity = Depends(authenticate)):
        m = await store.get(module_id)
        if m is None or not _visible_to(m, identity.conversation_id):
            # A private module the caller can't see is indistinguishable from missing.
            raise HTTPException(status_code=404, detail="module not found")
        return {**m.summary(), "files": m.files}

    @router.post("/modules", status_code=201)
    async def publish(body: dict = Body(...), identity: Identity = Depends(authenticate)):
        owner = identity.conversation_id
        if not owner:
            raise HTTPException(status_code=403, detail="a conversation identity is required to publish")
        module_id = (body.get("id") or "").strip()
        name = (body.get("name") or "").strip()
        files = body.get("files")
        if not module_id or not name:
            raise HTTPException(status_code=400, detail="id and name are required")
        if not isinstance(files, dict) or not files or "module.nix" not in files:
            raise HTTPException(status_code=400, detail="files must include module.nix")
        visibility = (body.get("visibility") or "private").strip()
        if visibility not in _VALID_VISIBILITY:
            raise HTTPException(status_code=400, detail="visibility must be private|public")
        try:
            m = await store.upsert(
                module_id=module_id, owner=owner, name=name,
                description=(body.get("description") or "").strip(),
                visibility=visibility, files=files, now_iso=now(),
            )
        except PermissionError as e:
            raise HTTPException(status_code=403, detail=str(e)) from e
        return m.summary()

    return router
