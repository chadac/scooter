"""Google Gemini ("Nano Banana") backend, over the Gemini API's Interactions endpoint
with an API key (GEMINI_API_KEY, from `contribs.imagegen.backends.gemini.apiKeySecret`).

Text-to-image, and editing when reference_image_path is set. Which models it offers
is `contribs.imagegen.backends.gemini.models`.
"""

from __future__ import annotations

import asyncio
import base64
import os
from typing import Any

import httpx

from ..config import ImagegenSettings
from ..manifest import BackendManifest, GenerateRequest, ModelManifest

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"
API_REVISION = "2026-05-20"

_ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"]
_IMAGE_SIZES = ["1K", "2K", "4K"]

PARAMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "aspect_ratio": {
            "type": "string",
            "enum": _ASPECT_RATIOS,
            "description": "Default: 1:1, or the reference image's own ratio.",
        },
        "image_size": {"type": "string", "enum": _IMAGE_SIZES, "description": "Default: 1K."},
    },
}


class GeminiBackend:
    name = "gemini"

    def __init__(self, api_key: str, models: list[str], client: httpx.AsyncClient | None = None) -> None:
        if not api_key:
            raise ValueError("gemini: GEMINI_API_KEY is not set")
        self.manifest = BackendManifest(
            models=tuple(
                ModelManifest(
                    name=model,
                    description="Gemini image generation; edits the image at reference_image_path when set.",
                    params_schema=PARAMS_SCHEMA,
                )
                for model in models
            )
        )
        self._client = client or httpx.AsyncClient(
            timeout=180,
            headers={"x-goog-api-key": api_key, "Api-Revision": API_REVISION},
        )

    async def generate(self, request: GenerateRequest) -> list[bytes]:
        body = _body(request)
        # One image per interaction; fan out for n.
        payloads = await asyncio.gather(*(self._post(body) for _ in range(request.n)))
        return [image for payload in payloads for image in _images(request.model, payload)]

    async def _post(self, body: dict[str, Any]) -> dict[str, Any]:
        resp = await self._client.post(ENDPOINT, json=body)
        if resp.status_code >= 300:
            raise RuntimeError(f"gemini: HTTP {resp.status_code}: {resp.text[:500]}")
        return resp.json()


def factory() -> GeminiBackend:
    cfg = ImagegenSettings().backends_config().get("gemini", {})
    return GeminiBackend(os.environ.get("GEMINI_API_KEY", ""), cfg["models"])


def _body(request: GenerateRequest) -> dict[str, Any]:
    content: list[dict[str, Any]] = [{"type": "text", "text": request.prompt}]
    if request.reference_image is not None:
        content.append(
            {
                "type": "image",
                "mime_type": _mime_type(request.reference_image),
                "data": base64.b64encode(request.reference_image).decode(),
            }
        )
    # No mime_type: the Interactions API accepts only image/jpeg, the default.
    response_format: dict[str, Any] = {"type": "image"}
    for key in ("aspect_ratio", "image_size"):
        if key in request.params:
            response_format[key] = request.params[key]
    # Nothing reads a generation back later, so don't leave prompts stored at Google.
    return {"model": request.model, "input": content, "response_format": response_format, "store": False}


def _images(model: str, payload: dict[str, Any]) -> list[bytes]:
    images = [
        base64.b64decode(block["data"])
        for step in payload.get("steps", [])
        if step.get("type") == "model_output"
        for block in step.get("content", [])
        if block.get("type") == "image" and block.get("data")
    ]
    if not images:
        text = " ".join(
            block.get("text", "")
            for step in payload.get("steps", [])
            for block in step.get("content", [])
            if block.get("type") == "text"
        ).strip()
        raise RuntimeError(f"{model} returned no image" + (f": {text[:500]}" if text else ""))
    return images


def _mime_type(data: bytes) -> str:
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    raise ValueError("gemini: reference_image_path must be a PNG, JPEG, WebP or GIF")
