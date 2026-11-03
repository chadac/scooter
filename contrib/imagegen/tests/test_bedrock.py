"""The Bedrock backend: configured model ids become the manifest, each sent in its
family's request shape, and an unknown family is refused up front.
"""

from __future__ import annotations

import base64

import pytest

from scooter_contrib_imagegen.backends.bedrock import BedrockBackend
from scooter_contrib_imagegen.manifest import GenerateRequest

_PNG = base64.b64encode(b"png").decode()


def _backend(models: list[str], payload: dict) -> tuple[BedrockBackend, list[tuple[str, dict]]]:
    backend = BedrockBackend("us-west-2", models)
    calls: list[tuple[str, dict]] = []

    def invoke(model_id: str, body: dict) -> dict:
        calls.append((model_id, body))
        return payload

    backend._invoke = invoke  # type: ignore[method-assign]
    return backend, calls


def test_manifest_follows_configured_order() -> None:
    backend, _ = _backend(["stability.stable-image-core-v1:1", "amazon.nova-canvas-v1:0"], {})
    assert [m.name for m in backend.manifest.models] == ["stability.stable-image-core-v1:1", "amazon.nova-canvas-v1:0"]
    assert "aspect_ratio" in backend.manifest.default_model.params_schema["properties"]


def test_unknown_family_is_refused() -> None:
    with pytest.raises(ValueError, match="unsupported image model"):
        BedrockBackend("us-west-2", ["openai.dall-e"])


async def test_stability_body_and_fan_out() -> None:
    backend, calls = _backend(["stability.stable-image-core-v1:1"], {"images": [_PNG], "finish_reasons": [None]})
    images = await backend.generate(
        GenerateRequest(prompt="a cat", model="stability.stable-image-core-v1:1", params={"seed": 7}, n=2)
    )
    assert images == [b"png", b"png"]
    assert calls[0] == (
        "stability.stable-image-core-v1:1",
        {"prompt": "a cat", "aspect_ratio": "1:1", "output_format": "png", "seed": 7},
    )


async def test_stability_filtered_raises() -> None:
    backend, _ = _backend(
        ["stability.stable-image-core-v1:1"], {"images": [], "finish_reasons": ["Filter reason: prompt"]}
    )
    with pytest.raises(RuntimeError, match="Filter reason: prompt"):
        await backend.generate(GenerateRequest(prompt="x", model="stability.stable-image-core-v1:1", params={}))


async def test_stability_rejects_reference_image() -> None:
    backend, calls = _backend(["stability.stable-image-core-v1:1"], {})
    with pytest.raises(ValueError, match="text-to-image only"):
        await backend.generate(
            GenerateRequest(prompt="x", model="stability.stable-image-core-v1:1", params={}, reference_image=b"img")
        )
    assert calls == []


async def test_amazon_body() -> None:
    backend, calls = _backend(["amazon.nova-canvas-v1:0"], {"images": [_PNG]})
    images = await backend.generate(GenerateRequest(prompt="a dog", model="amazon.nova-canvas-v1:0", params={}))
    assert images == [b"png"]
    assert calls[0][1]["taskType"] == "TEXT_IMAGE"
    assert calls[0][1]["imageGenerationConfig"]["numberOfImages"] == 1
