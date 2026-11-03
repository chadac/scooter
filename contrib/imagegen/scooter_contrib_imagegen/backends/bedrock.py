"""Amazon Bedrock backend, called with the broker pod's own IRSA identity (no secret
of ours to hold — `contribs.imagegen.backends.bedrock.roleArn` only annotates the
service account; boto3 picks the credentials up automatically).

Which models it offers is `contribs.imagegen.backends.bedrock.models`; each id is
matched by prefix to the model family that knows its request/response shape.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

import boto3

from ..config import ImagegenSettings
from ..manifest import Backend, BackendManifest, GenerateRequest, ModelManifest

logger = logging.getLogger(__name__)

Invoke = Callable[[str, dict[str, Any]], dict[str, Any]]


class BedrockBackend:
    name = "bedrock"

    def __init__(self, region: str, models: list[str]) -> None:
        self._families = {model_id: _family(model_id) for model_id in models}
        self.manifest = BackendManifest(
            models=tuple(
                ModelManifest(name=model_id, description=family.description, params_schema=family.params_schema)
                for model_id, family in self._families.items()
            )
        )
        self._client = boto3.client("bedrock-runtime", region_name=region)

    def _invoke(self, model_id: str, body: dict[str, Any]) -> dict[str, Any]:
        response = self._client.invoke_model(modelId=model_id, body=json.dumps(body))
        return json.loads(response["body"].read())

    async def generate(self, request: GenerateRequest) -> list[bytes]:
        # boto3 is sync; each family runs it off the event loop.
        return await self._families[request.model].generate(self._invoke, request)


def factory() -> Backend:
    cfg = ImagegenSettings().backends_config().get("bedrock", {})
    return BedrockBackend(cfg["region"], cfg["models"])


@dataclass(frozen=True)
class _Family:
    """A request/response shape shared by every Bedrock model id starting with a prefix."""

    prefixes: tuple[str, ...]
    description: str
    params_schema: dict[str, Any]
    generate: Callable[[Invoke, GenerateRequest], Awaitable[list[bytes]]]


_STABILITY_ASPECT_RATIOS = ["16:9", "1:1", "21:9", "2:3", "3:2", "4:5", "5:4", "9:16", "9:21"]


async def _generate_stability(invoke: Invoke, request: GenerateRequest) -> list[bytes]:
    if request.reference_image is not None:
        raise ValueError(f"{request.model} is text-to-image only; drop reference_image_path")
    body: dict[str, Any] = {
        "prompt": request.prompt,
        "aspect_ratio": request.params.get("aspect_ratio", "1:1"),
        "output_format": "png",
    }
    if "negative_prompt" in request.params:
        body["negative_prompt"] = request.params["negative_prompt"]
    if "seed" in request.params:
        body["seed"] = request.params["seed"]

    # One image per call; fan out for n.
    payloads = await asyncio.gather(*(asyncio.to_thread(invoke, request.model, body) for _ in range(request.n)))
    images: list[bytes] = []
    for payload in payloads:
        reasons = [r for r in payload.get("finish_reasons", []) if r]
        if reasons:
            raise RuntimeError(f"{request.model} returned no image: {'; '.join(reasons)}")
        images.extend(base64.b64decode(image) for image in payload["images"])
    return images


async def _generate_amazon(invoke: Invoke, request: GenerateRequest) -> list[bytes]:
    config = {
        "numberOfImages": request.n,
        "quality": request.params.get("quality", "standard"),
        "width": request.params.get("width", 1024),
        "height": request.params.get("height", 1024),
    }
    if "seed" in request.params:
        config["seed"] = request.params["seed"]

    if request.reference_image is None:
        body = {
            "taskType": "TEXT_IMAGE",
            "textToImageParams": {
                "text": request.prompt,
                **({"negativeText": request.params["negative_text"]} if "negative_text" in request.params else {}),
            },
            "imageGenerationConfig": config,
        }
    else:
        body = {
            "taskType": "IMAGE_VARIATION",
            "imageVariationParams": {
                "text": request.prompt,
                "images": [base64.b64encode(request.reference_image).decode()],
            },
            "imageGenerationConfig": config,
        }
    payload = await asyncio.to_thread(invoke, request.model, body)
    return [base64.b64decode(image) for image in payload["images"]]


_FAMILIES = (
    _Family(
        prefixes=("stability.",),
        description="Stability AI text-to-image (Stable Image Core/Ultra, SD3.5); no reference_image_path.",
        params_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "aspect_ratio": {"type": "string", "enum": _STABILITY_ASPECT_RATIOS, "description": "Default: 1:1."},
                "seed": {"type": "integer", "minimum": 0, "maximum": 4294967294},
                "negative_prompt": {"type": "string", "description": "What to avoid in the image."},
            },
        },
        generate=_generate_stability,
    ),
    _Family(
        prefixes=("amazon.titan-image-generator", "amazon.nova-canvas"),
        description=(
            "Amazon Titan/Nova Canvas — text-to-image, and image-to-image variation when reference_image_path is set."
        ),
        params_schema={
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "quality": {"type": "string", "enum": ["standard", "premium"], "description": "Default: standard."},
                "width": {"type": "integer", "enum": [512, 768, 1024], "description": "Default: 1024."},
                "height": {"type": "integer", "enum": [512, 768, 1024], "description": "Default: 1024."},
                "seed": {"type": "integer", "minimum": 0, "maximum": 2147483646},
                "negative_text": {"type": "string", "description": "What to avoid in the image."},
            },
        },
        generate=_generate_amazon,
    ),
)


def _family(model_id: str) -> _Family:
    for family in _FAMILIES:
        if model_id.startswith(family.prefixes):
            return family
    known = ", ".join(f"{p}*" for f in _FAMILIES for p in f.prefixes)
    raise ValueError(f"bedrock: unsupported image model {model_id!r} (supported: {known})")
