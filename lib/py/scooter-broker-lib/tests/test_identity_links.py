"""The broker writes identity links to the agent-host's /identity-links routes."""

from __future__ import annotations

import json

import httpx
import pytest

from scooter_broker_lib.identity_links import IdentityLinks


def recorder(status: int = 204):
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        return httpx.Response(status)

    return seen, httpx.MockTransport(handler)


async def test_link_puts_the_account_under_the_user():
    seen, transport = recorder()
    await IdentityLinks("http://agent-host/", transport=transport).link("github", "a/b@c", "42", "octo")
    [req] = seen
    assert req.method == "PUT"
    assert req.url.raw_path == b"/identity-links/github/a%2Fb%40c"
    assert json.loads(req.content) == {"externalId": "42", "handle": "octo"}


async def test_unlink_deletes_the_users_link():
    seen, transport = recorder()
    await IdentityLinks("http://agent-host", transport=transport).unlink("gitlab", "alice")
    [req] = seen
    assert req.method == "DELETE" and req.url.path == "/identity-links/gitlab/alice"


async def test_a_refusal_raises():
    _, transport = recorder(403)
    with pytest.raises(httpx.HTTPStatusError):
        await IdentityLinks("http://agent-host", transport=transport).link("github", "alice", "42", "octo")
