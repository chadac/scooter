"""The generic credential sources; provider-specific ones are tested with their contribs."""

from __future__ import annotations

import httpx
import pytest

from scooter_broker_lib.sources.file_token import FileTokenSource
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.types import Identity


def _identity() -> Identity:
    return Identity("conv1", "agent-sandbox", "system:serviceaccount:agent-sandbox:sandbox-conv1")


def _req() -> httpx.Request:
    """A throwaway outbound request for inject() to mutate."""
    return httpx.Request("GET", "https://example.test/x")


@pytest.mark.asyncio
async def test_static_token_source():
    src = StaticTokenSource(token="abc", kind="bearer")
    cred = await src.get(_identity())
    assert cred.kind == "bearer"
    assert cred.value == "abc"
    req = _req()
    cred.inject(req)
    assert req.headers["Authorization"] == "Bearer abc"


@pytest.mark.asyncio
async def test_static_token_header_kind():
    src = StaticTokenSource(token="glpat-x", kind="header", header_name="PRIVATE-TOKEN")
    cred = await src.get(_identity())
    req = _req()
    cred.inject(req)
    assert req.headers["PRIVATE-TOKEN"] == "glpat-x"


@pytest.mark.asyncio
async def test_file_token_source_rereads_the_file_on_every_request(tmp_path):
    path = tmp_path / "token"
    src = FileTokenSource(path)
    path.write_text("tok1\n")
    assert (await src.get(_identity())).value == "tok1"
    path.write_text("tok2")
    req = _req()
    (await src.get(_identity())).inject(req)
    assert req.headers["Authorization"] == "Bearer tok2"


@pytest.mark.asyncio
@pytest.mark.parametrize("content", [None, "", "  \n"])
async def test_file_token_source_injects_nothing_without_a_token(tmp_path, content):
    path = tmp_path / "token"
    if content is not None:
        path.write_text(content)
    req = _req()
    (await FileTokenSource(path).get(_identity())).inject(req)
    assert "authorization" not in req.headers


@pytest.mark.asyncio
async def test_file_token_source_header_kind(tmp_path):
    path = tmp_path / "token"
    path.write_text("glpat-x")
    req = _req()
    (await FileTokenSource(path, kind="header", header_name="PRIVATE-TOKEN").get(_identity())).inject(req)
    assert req.headers["PRIVATE-TOKEN"] == "glpat-x"
