"""GitHub's resource shapes and owner lookup — moved here with the provider.

These cases were in the webhooks app's test_resource_shapes / test_identity_resolve
until github became a contrib (PR #591). The knowledge is github's, so the tests
are too.

`conversation_map` holds ("pull_request", "chadac/scooter#487") while
`resource_links` holds ("pr", the html_url) — the same PR. An exact-match lookup in
either shape found nothing written in the other, so forwards were dropped and the
agent's reply tools were never armed (issue #563).
"""

from __future__ import annotations

import httpx
import pytest

import scooter_contrib_github.resources  # noqa: F401  (registers the shapes)
from scooter_contrib_github import identity as gh_identity
from scooter_contrib_github.config import settings
from scooter_webhooks_lib import identity as lib_identity
from scooter_webhooks_lib.resources import (
    canonical_link,
    canonical_resource_type,
    link_variants,
    resource_id_variants,
)

pytestmark = pytest.mark.asyncio


def _patch(monkeypatch, handler):
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real(*args, transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(gh_identity.httpx, "AsyncClient", factory)


# --- resource shapes ------------------------------------------------------------


async def test_github_short_id_offers_the_stored_url():
    assert (
        "pr",
        "https://github.com/chadac/scooter/pull/474",
    ) in link_variants("github", "pull_request", "chadac/scooter#474")


async def test_github_url_offers_the_short_id():
    assert (
        "pull_request",
        "chadac/scooter#474",
    ) in link_variants("github", "pr", "https://github.com/chadac/scooter/pull/474")


async def test_issue_urls_use_the_issues_path_not_pull():
    assert "https://github.com/o/r/issues/3" in resource_id_variants("github", "issue", "o/r#3")


async def test_the_callers_own_shape_is_tried_first():
    # A row written in the caller's own terms must still win without a rewrite.
    assert link_variants("github", "pull_request", "chadac/scooter#1")[0] == (
        "pull_request",
        "chadac/scooter#1",
    )


async def test_an_unparseable_id_invents_no_url():
    # No guessing: an id that names nothing known must not resolve to someone
    # else's resource — the agent stays quiet instead.
    assert resource_id_variants("github", "pull_request", "not-a-resource-id") == ["not-a-resource-id"]


async def test_type_aliases_are_two_way():
    assert canonical_resource_type("github", "pr") == "pull_request"
    # An unknown type passes through rather than being mangled into a wrong one.
    assert canonical_resource_type("github", "discussion") == "discussion"


async def test_canonical_link_stores_the_long_type_and_the_url():
    # URL form is what resource_links already (almost entirely) holds, and the long
    # type is what conversation_map holds + what the UI renders.
    assert canonical_link("github", "pr", "chadac/scooter#7") == (
        "pull_request",
        "https://github.com/chadac/scooter/pull/7",
    )


async def test_canonical_link_keeps_an_id_it_cannot_widen():
    assert canonical_link("github", "pr", "not-an-id") == ("pull_request", "not-an-id")


# --- owner lookup ---------------------------------------------------------------


async def test_github_public_email(monkeypatch):
    monkeypatch.setattr(settings, "github_token", "", raising=False)

    def handler(req):
        assert "/users/octocat" in str(req.url)
        return httpx.Response(200, json={"login": "octocat", "email": "cat@github.com"})

    _patch(monkeypatch, handler)
    assert await lib_identity.get_user_email("github", "octocat") == "cat@github.com"


async def test_github_private_email_is_none(monkeypatch):
    _patch(monkeypatch, lambda req: httpx.Response(200, json={"login": "octocat", "email": None}))
    assert await lib_identity.get_user_email("github", "octocat") is None
