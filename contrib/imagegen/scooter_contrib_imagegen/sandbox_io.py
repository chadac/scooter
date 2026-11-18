"""Materializing bytes into (and reading bytes out of) the conversation's sandbox.

A broker tool runs in the broker pod, not the sandbox, so an image a backend
generated has to be handed to agent-host to write — the same way an uploaded
attachment is, through agent-host's generic `/conversations/<id>/files` route.
"""

from __future__ import annotations

import base64
import logging

import httpx

from scooter_broker_lib.autolink import router_headers

logger = logging.getLogger(__name__)

# Where generated images land in the sandbox.
IMAGES_DIR = "/workspace/images"


class SandboxIOError(Exception):
    """Could not write/read a file through agent-host."""


async def write_image(agent_host_url: str, conversation_id: str, name: str, data: bytes) -> str:
    """POST the bytes to agent-host, which writes them into IMAGES_DIR and returns the path it used (sanitized, so it may differ from `name`)."""
    if not agent_host_url:
        raise SandboxIOError("no agent-host URL configured (AGENT_HOST_URL) — cannot write the image anywhere")
    url = f"{agent_host_url.rstrip('/')}/conversations/{conversation_id}/files"
    async with httpx.AsyncClient(timeout=30, headers=router_headers()) as client:
        resp = await client.post(url, json={"dir": IMAGES_DIR, "name": name, "data": base64.b64encode(data).decode()})
    if resp.status_code >= 300:
        raise SandboxIOError(f"agent-host rejected the write (HTTP {resp.status_code}): {resp.text}")
    return resp.json()["path"]


async def read_reference_image(agent_host_url: str, conversation_id: str, path: str) -> bytes:
    """GET `path`'s bytes out of the sandbox through agent-host."""
    if not agent_host_url:
        raise SandboxIOError("no agent-host URL configured (AGENT_HOST_URL) — cannot read reference_image_path")
    url = f"{agent_host_url.rstrip('/')}/conversations/{conversation_id}/files"
    async with httpx.AsyncClient(timeout=30, headers=router_headers()) as client:
        resp = await client.get(url, params={"path": path})
    if resp.status_code >= 300:
        raise SandboxIOError(f"agent-host could not read {path!r} (HTTP {resp.status_code}): {resp.text}")
    return base64.b64decode(resp.json()["data"])
