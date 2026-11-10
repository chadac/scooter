"""guarded_get keeps a referenced URL and its redirects off internal addresses, and the ref helpers format what the agent sees."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from scooter_lib.attachments import (
    AttachmentRef,
    Fetched,
    FetchError,
    as_text,
    dedupe,
    fenced,
    from_response,
    guarded_get,
    inline_images,
    refs_block,
    sniff_image,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 32


def _forge(host: str) -> bool:
    return host == "forge.example"


async def _public(host: str) -> list[str]:
    return {"blob.example": ["52.1.2.3"], "meta.example": ["169.254.169.254"]}.get(host, ["10.0.0.1"])


def _get(handler, url: str, **kwargs) -> Fetched:
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await guarded_get(
                client, url, allowed=_forge, resolve=_public,
                max_bytes=kwargs.pop("max_bytes", 1024), **kwargs,
            )

    return asyncio.run(run())


def test_follows_a_redirect_to_public_storage_and_drops_the_credential():
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.headers.get("authorization")))
        if request.url.host == "forge.example":
            return httpx.Response(302, headers={"location": "https://blob.example/x?sig=1"})
        return httpx.Response(200, content=PNG, headers={"content-type": "application/octet-stream"})

    fetched = _get(handler, "https://forge.example/a.png", headers={"Authorization": "Bearer t"})

    assert fetched.data == PNG
    assert seen == [("forge.example", "Bearer t"), ("blob.example", None)]


def test_refuses_a_redirect_to_the_metadata_address():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "forge.example":
            return httpx.Response(302, headers={"location": "https://meta.example/latest"})
        raise AssertionError("the metadata host must never be requested")

    with pytest.raises(FetchError, match="non-public"):
        _get(handler, "https://forge.example/a.png")


def test_refuses_a_plain_http_hop_off_the_forge():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://blob.example/x"})

    with pytest.raises(FetchError, match="non-https"):
        _get(handler, "https://forge.example/a.png")


def test_refuses_a_url_off_the_source_hosts():
    with pytest.raises(FetchError, match="not one of"):
        _get(lambda r: httpx.Response(200), "https://imgur.example/a.png")


def test_caps_the_streamed_body():
    with pytest.raises(FetchError, match="limit"):
        _get(lambda r: httpx.Response(200, content=b"x" * 2048), "https://forge.example/big.log")


def test_stops_a_redirect_loop():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "/again"})

    with pytest.raises(FetchError, match="redirects"):
        _get(handler, "https://forge.example/a.png")


def _from(api: httpx.Response, handler) -> Fetched:
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await from_response(client, api, max_bytes=1024, resolve=_public)

    return asyncio.run(run())


def _api(status: int, **kwargs) -> httpx.Response:
    return httpx.Response(status, request=httpx.Request("GET", "https://forge.example/api/x"), **kwargs)


def test_an_api_redirect_is_followed_without_the_credential():
    seen: list[tuple[str, str | None]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append((request.url.host, request.headers.get("authorization")))
        return httpx.Response(200, content=PNG)

    fetched = _from(_api(302, headers={"location": "https://blob.example/x?sig=1"}), handler)

    assert fetched.data == PNG
    assert fetched.url == "https://blob.example/x?sig=1"
    assert seen == [("blob.example", None)]


def test_an_api_redirect_back_inside_the_cluster_is_refused():
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("an internal host must never be requested")

    # After an API redirect even the forge host is untrusted.
    with pytest.raises(FetchError, match="non-public"):
        _from(_api(302, headers={"location": "https://forge.example/internal"}), handler)


def test_an_api_body_is_capped_and_errors_are_named():
    with pytest.raises(FetchError, match="limit"):
        _from(_api(200, content=b"x" * 2048), lambda r: httpx.Response(500))
    with pytest.raises(FetchError, match="HTTP 403"):
        _from(_api(403), lambda r: httpx.Response(500))


def test_sniffs_images_and_reads_text():
    assert sniff_image(PNG) == "image/png"
    assert sniff_image(b"GIF89a....") == "image/gif"
    assert sniff_image(b"plain") is None
    assert as_text("build.log", b"ok\n", "application/octet-stream") == "ok\n"
    assert as_text("core.bin", b"\x00\x01", "application/octet-stream") is None


def test_fence_outgrows_backticks_in_the_content():
    assert fenced("a.md", "```x```").startswith("a.md:\n````\n")


def test_refs_block_lists_each_ref_once():
    a = AttachmentRef("a.png", "r:1", image=True)
    b = AttachmentRef("b.log", "r:2", image=False)
    block = refs_block("forge_attachment", dedupe([a, b, a]))
    assert block.count("r:1") == 1
    assert "- a.png (image), ref: `r:1`" in block
    assert "- b.log, ref: `r:2`" in block
    assert refs_block("forge_attachment", []) == ""


def test_inline_images_tries_only_the_first_images_and_skips_failures():
    refs = [AttachmentRef(f"{i}.png", f"r:{i}", image=True) for i in range(4)]

    async def fetch(ref: AttachmentRef) -> Fetched:
        if ref.ref == "r:1":
            raise FetchError("gone")
        return Fetched(PNG, "image/png")

    fetched: list[str] = []

    async def counting(ref: AttachmentRef) -> Fetched:
        fetched.append(ref.ref)
        return await fetch(ref)

    images = asyncio.run(inline_images(refs, counting, limit=3))
    assert len(images) == 2
    assert sorted(fetched) == ["r:0", "r:1", "r:2"]
