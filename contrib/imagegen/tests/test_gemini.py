"""The Gemini backend: request body per GenerateRequest, images pulled out of the
interaction's model_output steps, and a text-only reply surfaced as an error.
"""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from scooter_contrib_imagegen.backends.gemini import ENDPOINT, GeminiBackend
from scooter_contrib_imagegen.manifest import GenerateRequest

_PNG = b"\x89PNG\r\n\x1a\nfake"
_MODEL = "gemini-nano-banana-2.1"


def _image_payload(data: bytes = _PNG) -> dict:
    block = {"type": "image", "mime_type": "image/png", "data": base64.b64encode(data).decode()}
    return {"status": "completed", "steps": [{"type": "model_output", "content": [block]}]}


def _backend(response: httpx.Response) -> tuple[GeminiBackend, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return response

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), headers={"x-goog-api-key": "k"})
    return GeminiBackend("k", [_MODEL, "gemini-3-pro-image"], client=client), seen


def test_manifest_follows_configured_order() -> None:
    backend, _ = _backend(httpx.Response(200, json={}))
    assert [m.name for m in backend.manifest.models] == [_MODEL, "gemini-3-pro-image"]
    assert set(backend.manifest.default_model.params_schema["properties"]) == {"aspect_ratio", "image_size"}


def test_missing_key_is_refused() -> None:
    with pytest.raises(ValueError, match="GEMINI_API_KEY"):
        GeminiBackend("", [_MODEL])


async def test_text_to_image_body_and_fan_out() -> None:
    backend, seen = _backend(httpx.Response(200, json=_image_payload()))
    images = await backend.generate(
        GenerateRequest(prompt="a cat", model=_MODEL, params={"aspect_ratio": "16:9"}, n=2)
    )
    assert images == [_PNG, _PNG]
    assert len(seen) == 2
    assert str(seen[0].url) == ENDPOINT
    assert seen[0].headers["x-goog-api-key"] == "k"
    assert json.loads(seen[0].content) == {
        "model": _MODEL,
        "input": [{"type": "text", "text": "a cat"}],
        "response_format": {"type": "image", "aspect_ratio": "16:9"},
        "store": False,
    }


async def test_reference_image_is_sent_inline() -> None:
    backend, seen = _backend(httpx.Response(200, json=_image_payload()))
    await backend.generate(GenerateRequest(prompt="make it blue", model=_MODEL, params={}, reference_image=_PNG))
    reference = json.loads(seen[0].content)["input"][1]
    assert reference == {"type": "image", "mime_type": "image/png", "data": base64.b64encode(_PNG).decode()}


async def test_unknown_reference_format_is_refused() -> None:
    backend, seen = _backend(httpx.Response(200, json=_image_payload()))
    with pytest.raises(ValueError, match="PNG, JPEG, WebP or GIF"):
        await backend.generate(GenerateRequest(prompt="x", model=_MODEL, params={}, reference_image=b"BM bitmap"))
    assert seen == []


async def test_text_only_reply_raises_with_its_text() -> None:
    payload = {"steps": [{"type": "model_output", "content": [{"type": "text", "text": "I can't draw that."}]}]}
    backend, _ = _backend(httpx.Response(200, json=payload))
    with pytest.raises(RuntimeError, match="returned no image: I can't draw that."):
        await backend.generate(GenerateRequest(prompt="x", model=_MODEL, params={}))


async def test_http_error_raises() -> None:
    backend, _ = _backend(httpx.Response(429, text="quota exceeded"))
    with pytest.raises(RuntimeError, match="HTTP 429: quota exceeded"):
        await backend.generate(GenerateRequest(prompt="x", model=_MODEL, params={}))
