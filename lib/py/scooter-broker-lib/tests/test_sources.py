"""The generic credential sources; provider-specific ones are tested with their contribs."""

from __future__ import annotations

import httpx
import pytest

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
