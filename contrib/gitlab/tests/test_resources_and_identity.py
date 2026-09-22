"""GitLab's resource shapes and owner lookup — moved here with the provider.

These cases were in the webhooks app's test_resource_shapes / test_identity_resolve
until gitlab became a contrib (PR #580). The knowledge is gitlab's, so the tests
are too.
"""

from __future__ import annotations

import httpx
import pytest

import scooter_contrib_gitlab.resources  # noqa: F401  (registers the shapes)
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


async def test_a_short_id_stays_itself():
    # The instance host is not in `acme/web!7`, so widening it would invent a
    # gitlab.com URL that may name a different instance's MR.
    assert resource_id_variants("gitlab", "mr", "acme/web!7") == ["acme/web!7"]
    assert canonical_link("gitlab", "mr", "acme/web!7") == ("merge_request", "acme/web!7")


async def test_type_aliases_are_two_way():
    pairs = link_variants("gitlab", "mr", "acme/web!7")
    assert pairs[0] == ("mr", "acme/web!7")  # the caller's own shape first
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
    # No token -> no lookup at all (the API would 401 and leak nothing useful).
    monkeypatch.setattr(settings, "gitlab_token", "", raising=False)
    assert await lib_identity.get_user_email("gitlab", "alice") is None
