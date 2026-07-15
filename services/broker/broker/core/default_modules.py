"""Deployment-default module serving — the pod's boot-time read path.

Every sandbox pod, at re-converge time, fetches the DEPLOYMENT'S DEFAULT NixOS
modules from the broker as one gzipped tarball:

    GET /modules/default.tar.gz   ->   application/gzip

a gzipped tar of the `.nix` files the deployment ships as defaults, which
`broker-modules.nix` pulls directly with `builtins.fetchTarball` and imports.

This is UNAUTHENTICATED on purpose: the pod fetches it at boot (before it has any
useful identity), and the module Nix is not a secret — it's the config the sandbox
would build anyway. It carries the deployment's baseline; the per-conversation
registry modules (attach/enable) are a separate, authenticated path.

The source of the defaults for THIS PR is a plain directory of `.nix` files the
broker has mounted (`SANDBOX_DEFAULT_MODULES_DIR`). Empty/unset -> an empty tarball
(the pod imports nothing, boots on baseline). No k8s access needed.
"""

from __future__ import annotations

import gzip
import io
import logging
import os
import tarfile

from fastapi import APIRouter
from fastapi.responses import Response

from ..config import settings

logger = logging.getLogger(__name__)


def _read_default_module_files() -> dict[str, str]:
    """Read the deployment's default `.nix` files from SANDBOX_DEFAULT_MODULES_DIR.

    Returns {filename -> content} for each `.nix` file directly in the dir. An unset
    or non-existent dir -> {} (an empty tarball; the pod imports nothing)."""
    dir_path = settings.sandbox_default_modules_dir
    if not dir_path or not os.path.isdir(dir_path):
        return {}
    out: dict[str, str] = {}
    for fname in sorted(os.listdir(dir_path)):
        if not fname.endswith(".nix"):
            continue
        fpath = os.path.join(dir_path, fname)
        if not os.path.isfile(fpath):
            continue
        with open(fpath, encoding="utf-8") as fh:
            out[fname] = fh.read()
    return out


def _build_tarball(files: dict[str, str]) -> bytes:
    """Gzipped tar of each default `.nix` file at the tar root. Deterministic (fixed
    mtime) so a fetchTarball of an unchanged default set hashes the same."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for fname, content in files.items():
            data = content.encode("utf-8")
            info = tarfile.TarInfo(name=fname)
            info.size = len(data)
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


def create_default_modules_router() -> APIRouter:
    router = APIRouter()

    @router.get("/modules/default.tar.gz")
    async def get_default_modules_tarball() -> Response:
        # UNAUTHENTICATED — the pod fetches at boot; module Nix isn't a secret.
        body = _build_tarball(_read_default_module_files())
        return Response(content=body, media_type="application/gzip")

    return router
