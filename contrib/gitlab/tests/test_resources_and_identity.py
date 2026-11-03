"""GitLab's resource shapes and owner lookup."""

from __future__ import annotations

import httpx
import pytest

import scooter_contrib_gitlab.resources  # noqa: F401
from scooter_contrib_gitlab import identity as gl_identity
from scooter_contrib_gitlab.config import settings
from scooter_webhooks_lib import identity as lib_identity
from scooter_webhooks_lib.resources import canonical_link, link_variants, resource_id_variants

pytestmark = pytest.mark.asyncio


def _patch(monkeypatch, handler):
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(gl_identity.httpx, "AsyncClient", factory)


# --- resource shapes ------------------------------------------------------------


async def test_gitlab_url_offers_the_short_forms():
    assert resource_id_variants(
        "gitlab", "merge_request", "https://gitlab.com/acme/web/-/merge_requests/7"
    ) == ["https://gitlab.com/acme/web/-/merge_requests/7", "acme/web!7"]
    assert resource_id_variants(
        "gitlab", "issue", "https://gitlab.com/acme/web/issues/12"
    ) == ["https://gitlab.com/acme/web/issues/12", "acme/web#12"]


async def test_a_short_id_offers_the_url_on_the_configured_host(monkeypatch):
    monkeypatch.setattr(settings, "gitlab_host", "gitlab.example.com")
    assert resource_id_variants("gitlab", "mr", "group/sub/web!7") == [
        "group/sub/web!7", "https://gitlab.example.com/group/sub/web/-/merge_requests/7",
    ]
    assert resource_id_variants("gitlab", "issue", "acme/web#12") == [
        "acme/web#12", "https://gitlab.example.com/acme/web/-/issues/12",
    ]
    assert canonical_link("gitlab", "mr", "acme/web!7") == (
        "merge_request", "https://gitlab.example.com/acme/web/-/merge_requests/7",
    )


async def test_an_unparseable_id_stays_itself():
    assert resource_id_variants("gitlab", "mr", "not-a-resource") == ["not-a-resource"]


async def test_type_aliases_are_two_way():
    pairs = link_variants("gitlab", "mr", "acme/web!7")
    assert pairs[0] == ("mr", "acme/web!7")
    assert ("merge_request", "acme/web!7") in pairs


async def test_canonical_link_stores_the_long_type_and_the_url():
    assert canonical_link(
        "gitlab", "mr", "https://gitlab.com/acme/web/-/merge_requests/7"
    ) == ("merge_request", "https://gitlab.com/acme/web/-/merge_requests/7")


# --- owner lookup ---------------------------------------------------------------


async def test_gitlab_email(monkeypatch):
    monkeypatch.setattr(settings, "gitlab_token", "glpat-1", raising=False)

    def handler(req):
        assert req.headers["PRIVATE-TOKEN"] == "glpat-1"
        assert req.url.params.get("username") == "alice"
        return httpx.Response(200, json=[{"email": "alice@gl.io"}])

    _patch(monkeypatch, handler)
    assert await lib_identity.get_user_email("gitlab", "alice") == "alice@gl.io"


async def test_gitlab_no_token(monkeypatch):
    monkeypatch.setattr(settings, "gitlab_token", "", raising=False)
    assert await lib_identity.get_user_email("gitlab", "alice") is None
