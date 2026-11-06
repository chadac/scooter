"""The shares transport: publish a bundle, serve it at /s/<uuid>/.

    POST   /shares            publish a new share (authed), minting a UUID and url
    PUT    /shares/{uuid}     update an existing share (authed, owner-only) with a new version
    GET    /shares            list the caller's own shares (authed)
    GET    /shares/{uuid}     one share's metadata and latest manifest (authed, owner-only)
    DELETE /shares/{uuid}     delete a share and all versions (authed, owner-only)

    GET    /s/{uuid}/                serve the latest bundle's entry point (unauthenticated)
    GET    /s/{uuid}/{path}          serve any file from the latest bundle
    GET    /s/{uuid}/v/{n}/          serve version n's entry point
    GET    /s/{uuid}/v/{n}/{path}    serve a file from version n

Serving under /s/ is unauthenticated because the UUID is an unguessable capability;
`visibility` is carried but not yet enforced on the serve path. The publish payload is
JSON with either an inline file map or a base64 zip the broker unpacks:

    {"description": "...", "visibility": "public", "entry_point": "index.html",
     "files": {"index.html": {"content_type": "text/html", "b64": "..."},
               "chart.png":  {"content_type": "image/png",  "b64": "..."}}}
    # or:
    {"zip_b64": "<base64 of a .zip>"}
"""

from __future__ import annotations

import base64
import binascii
import io
import logging
import mimetypes
import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import Response

from scooter_broker_lib.types import AuthDependency, Identity, Provider
from scooter_broker_lib.user import user_identity

from .store import ShareFile, ShareStore

logger = logging.getLogger(__name__)

# --- limits and whitelist ---------------------------------------------------
_MAX_FILE_BYTES = 10 * 1024 * 1024          # 10 MB per file
_MAX_TOTAL_BYTES = 100 * 1024 * 1024        # 100 MB per bundle
_MAX_FILE_COUNT = 200
_ALLOWED_EXT = {
    ".html", ".htm", ".css", ".js", ".mjs", ".json", ".csv", ".txt", ".md",
    ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2",
    ".map", ".xml", ".wasm",
}
_VALID_VISIBILITY = {"public", "private"}

# The Scooter UI's favicon (services/ui/index.html), for pages that declare none.
_DEFAULT_FAVICON_LINK = (
    b"<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' "
    b"viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%9B%B4%3C/text%3E%3C/svg%3E\">"
)
_ICON_LINK_RE = re.compile(rb"<link\b[^>]*\brel\s*=\s*[\"']?[^\"'>]*\bicon\b", re.IGNORECASE)
# Insert after the first match; never before a doctype.
_FAVICON_ANCHORS = [
    re.compile(rb"<head\b[^>]*>", re.IGNORECASE),
    re.compile(rb"<html\b[^>]*>", re.IGNORECASE),
    re.compile(rb"<!doctype\b[^>]*>", re.IGNORECASE),
]


def _with_default_favicon(html: bytes) -> bytes:
    """Add the Scooter favicon to an HTML page that has no icon link of its own."""
    if _ICON_LINK_RE.search(html):
        return html
    for anchor in _FAVICON_ANCHORS:
        m = anchor.search(html)
        if m:
            return html[: m.end()] + _DEFAULT_FAVICON_LINK + html[m.end():]
    return _DEFAULT_FAVICON_LINK + html


def _guess_content_type(path: str, given: str | None = None) -> str:
    if given:
        return given
    ctype, _ = mimetypes.guess_type(path)
    return ctype or "application/octet-stream"


def _safe_rel_path(name: str) -> str:
    """Normalize a bundle path and reject traversal or absolute paths, so a zip entry cannot escape the bundle namespace."""
    n = name.replace("\\", "/").lstrip("/")
    norm = posixpath.normpath(n)
    if norm.startswith("../") or norm == ".." or norm.startswith("/") or norm == ".":
        raise HTTPException(status_code=400, detail=f"unsafe path in bundle: {name!r}")
    return norm


def _check_ext(path: str) -> None:
    ext = posixpath.splitext(path)[1].lower()
    if ext not in _ALLOWED_EXT:
        raise HTTPException(
            status_code=400,
            detail=f"file type not allowed: {path!r} (allowed: {sorted(_ALLOWED_EXT)})",
        )


def _validate_bundle(files: dict[str, ShareFile]) -> None:
    if not files:
        raise HTTPException(status_code=400, detail="bundle is empty")
    if len(files) > _MAX_FILE_COUNT:
        raise HTTPException(status_code=400, detail=f"too many files (max {_MAX_FILE_COUNT})")
    total = 0
    for f in files.values():
        _check_ext(f.path)
        if f.size > _MAX_FILE_BYTES:
            raise HTTPException(status_code=400, detail=f"file too large: {f.path!r}")
        total += f.size
    if total > _MAX_TOTAL_BYTES:
        raise HTTPException(status_code=400, detail="bundle exceeds total size limit")


def _files_from_inline(raw: dict) -> dict[str, ShareFile]:
    """Build a bundle from an inline {path: {content_type, b64}} map."""
    out: dict[str, ShareFile] = {}
    for path, meta in raw.items():
        rel = _safe_rel_path(path)
        if not isinstance(meta, dict) or "b64" not in meta:
            raise HTTPException(status_code=400, detail=f"file {path!r} must be {{content_type, b64}}")
        try:
            data = base64.b64decode(meta["b64"], validate=True)
        except (binascii.Error, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"bad base64 for {path!r}") from e
        out[rel] = ShareFile(path=rel, content_type=_guess_content_type(rel, meta.get("content_type")), data=data)
    return out


def _files_from_zip(zip_b64: str) -> dict[str, ShareFile]:
    """Unpack a base64 zip into a bundle, guarding path traversal and size."""
    try:
        raw = base64.b64decode(zip_b64, validate=True)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(status_code=400, detail="zip_b64 is not valid base64") from e
    out: dict[str, ShareFile] = {}
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                rel = _safe_rel_path(info.filename)
                if info.file_size > _MAX_FILE_BYTES:
                    raise HTTPException(status_code=400, detail=f"zip entry too large: {rel!r}")
                out[rel] = ShareFile(path=rel, content_type=_guess_content_type(rel), data=zf.read(info))
    except zipfile.BadZipFile as e:
        raise HTTPException(status_code=400, detail="zip_b64 is not a valid zip") from e
    return out


def _bundle_from_body(body: dict) -> dict[str, ShareFile]:
    inline = body.get("files")
    zip_b64 = body.get("zip_b64")
    if bool(inline) == bool(zip_b64):
        raise HTTPException(status_code=400, detail="supply exactly one of `files` or `zip_b64`")
    files = _files_from_zip(zip_b64) if zip_b64 else _files_from_inline(inline)
    _validate_bundle(files)
    return files


def _resolve_entry_point(files: dict[str, ShareFile], requested: str | None) -> str:
    """Pick the bundle's entry point: an explicit one, else index.html, else the sole file."""
    if requested:
        rel = _safe_rel_path(requested)
        if rel not in files:
            raise HTTPException(status_code=400, detail=f"entry_point {requested!r} not in bundle")
        return rel
    if "index.html" in files:
        return "index.html"
    if len(files) == 1:
        return next(iter(files))
    raise HTTPException(
        status_code=400,
        detail="no entry_point: include an index.html, upload a single file, or set entry_point",
    )


def create_shares_router(
    store: ShareStore,
    *,
    authed: AuthDependency,
    public_base_url: str = "",
    frame_ancestors: str = "'self'",
    now: Callable[[], str] = lambda: "",
    on_change: Callable[[str], Awaitable[None]] | None = None,
) -> APIRouter:
    router = APIRouter()

    # Tells open Shares sections to refetch.
    async def _changed(conversation_id: str) -> None:
        if on_change is not None:
            await on_change(conversation_id)

    def _url(uuid: str) -> str:
        base = public_base_url.rstrip("/")
        return f"{base}/s/{uuid}/" if base else f"/s/{uuid}/"

    # Headers on every served file: frame-ancestors restricts embedding to the Scooter UI,
    # and nosniff stops the browser re-interpreting an asset as an executable type.
    def _serve_headers() -> dict[str, str]:
        return {
            "Content-Security-Policy": f"frame-ancestors {frame_ancestors}",
            "X-Content-Type-Options": "nosniff",
        }

    # --- management API (authed, owner-scoped) ------------------------------
    @router.post("/shares", status_code=201)
    async def publish(body: dict = Body(...), identity: Identity = Depends(authed)):
        owner = identity.conversation_id
        if not owner:
            raise HTTPException(status_code=403, detail="a conversation identity is required to publish")
        files = _bundle_from_body(body)
        entry_point = _resolve_entry_point(files, (body.get("entry_point") or "").strip() or None)
        visibility = (body.get("visibility") or "public").strip()
        if visibility not in _VALID_VISIBILITY:
            raise HTTPException(status_code=400, detail="visibility must be public|private")
        share = await store.create(
            owner=owner, conversation_id=owner,
            description=(body.get("description") or "").strip(),
            visibility=visibility, files=files, entry_point=entry_point, now_iso=now(),
        )
        await _changed(owner)
        return {**share.summary(), "url": _url(share.uuid), "entry_point": entry_point}

    @router.put("/shares/{uuid}")
    async def update(uuid: str, body: dict = Body(...), identity: Identity = Depends(authed)):
        owner = identity.conversation_id
        if not owner:
            raise HTTPException(status_code=403, detail="a conversation identity is required")
        files = _bundle_from_body(body)
        entry_point = _resolve_entry_point(files, (body.get("entry_point") or "").strip() or None)
        desc = body.get("description")
        try:
            share = await store.add_version(
                uuid, owner=owner, files=files, entry_point=entry_point,
                description=desc.strip() if isinstance(desc, str) else None, now_iso=now(),
            )
        except KeyError:
            raise HTTPException(status_code=404, detail="share not found") from None
        except PermissionError as e:
            raise HTTPException(status_code=403, detail=str(e)) from e
        await _changed(owner)
        return {**share.summary(), "url": _url(share.uuid), "entry_point": entry_point}

    async def _listing(owner: str) -> dict:
        shares = await store.list_by_owner(owner)
        return {"shares": [{**s.summary(), "url": _url(s.uuid)} for s in shares]}

    @router.get("/shares")
    async def list_shares(identity: Identity = Depends(authed)):
        return await _listing(identity.conversation_id)

    # The UI's Shares tab, through the agent-host's conversation relay, which has
    # already checked the user may see this conversation.
    @router.get("/shares/conversation/{conversation_id}/list")
    async def list_for_conversation(conversation_id: str, _user: str = Depends(user_identity(authed))):
        return await _listing(conversation_id)

    @router.get("/shares/{uuid}")
    async def get_share(uuid: str, identity: Identity = Depends(authed)):
        share = await store.get(uuid)
        if share is None or share.owner != identity.conversation_id:
            # A share the caller does not own is indistinguishable from missing.
            raise HTTPException(status_code=404, detail="share not found")
        version = await store.get_version(uuid)
        return {
            **share.summary(),
            "url": _url(uuid),
            "entry_point": version.entry_point if version else None,
            "manifest": version.manifest() if version else [],
        }

    @router.delete("/shares/{uuid}", status_code=204)
    async def delete_share(uuid: str, identity: Identity = Depends(authed)):
        try:
            ok = await store.delete(uuid, owner=identity.conversation_id)
        except PermissionError:
            raise HTTPException(status_code=404, detail="share not found") from None
        if not ok:
            raise HTTPException(status_code=404, detail="share not found")
        await _changed(identity.conversation_id)
        return Response(status_code=204)

    # --- serving (unauthenticated capability URL) ---------------------------
    async def _serve(uuid: str, version: int | None, path: str) -> Response:
        ver = await store.get_version(uuid, version)
        if ver is None:
            raise HTTPException(status_code=404, detail="not found")
        rel = _safe_rel_path(path) if path else ver.entry_point
        f = ver.files.get(rel)
        if f is None:
            raise HTTPException(status_code=404, detail="not found")
        data = f.data
        if f.content_type.split(";")[0].strip().lower() == "text/html":
            data = _with_default_favicon(data)
        return Response(content=data, media_type=f.content_type, headers=_serve_headers())

    @router.get("/s/{uuid}/v/{version}/{path:path}")
    async def serve_versioned(uuid: str, version: int, path: str) -> Response:
        return await _serve(uuid, version, path)

    @router.get("/s/{uuid}/v/{version}/")
    @router.get("/s/{uuid}/v/{version}")
    async def serve_versioned_root(uuid: str, version: int) -> Response:
        return await _serve(uuid, version, "")

    @router.get("/s/{uuid}/{path:path}")
    async def serve_latest(uuid: str, path: str) -> Response:
        return await _serve(uuid, None, path)

    @router.get("/s/{uuid}/")
    @router.get("/s/{uuid}")
    async def serve_latest_root(uuid: str) -> Response:
        return await _serve(uuid, None, "")

    return router


@dataclass
class Shares:
    """The transport the provider mounts at the broker root, so its paths are absolute."""

    store: ShareStore
    public_base_url: str = ""
    frame_ancestors: str = "'self'"
    on_change: Callable[[str], Awaitable[None]] | None = None
    name: str = field(default="shares", init=False)

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        return create_shares_router(
            self.store,
            authed=authed,
            public_base_url=self.public_base_url,
            frame_ancestors=self.frame_ancestors,
            on_change=self.on_change,
        )
