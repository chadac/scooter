"""External-user → Scooter-user mapping (identity_resolve): fetch the invoking
user's email per provider, then match a Scooter user via the agent-host /users/by-email.
Best-effort: any miss -> None (unowned). See todo/IDENTITY_MAPPING.md.

github is the vehicle for the generic chain: slack's resolver left with its contrib
(PR #588), and the app's only remaining resolver is github's.
"""

import httpx
import pytest

import webhooks.identity_resolve as ir
from scooter_webhooks_lib import agent_host_client as ahc
from scooter_webhooks_lib import identity as lib_identity
from webhooks.config import settings

pytestmark = pytest.mark.asyncio


def _patch(monkeypatch, handler):
    real = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs.pop("transport", None)
        return real(*args, transport=httpx.MockTransport(handler), **kwargs)

    # BOTH sides of the split: the provider email lookup is app-side (`ir`), the
    # /users/by-email leg is now the lib agent-host client. Patching only one leaves
    # the other making a real connection. Why: PR #575.
    monkeypatch.setattr(ir.httpx, "AsyncClient", factory)
    monkeypatch.setattr(ahc.httpx, "AsyncClient", factory)


# --- per-provider email fetch -------------------------------------------------


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


async def test_unknown_provider(monkeypatch):
    assert await lib_identity.get_user_email("bitbucket", "x") is None


# --- resolve_owner (email -> agent-host by-email) -----------------------------


def _chain_handler(email: str | None, scooter_id: str | None):
    """A transport that answers BOTH legs of the chain. /users/by-email is checked
    first: the github user lookup is also a /users/ path, so ordering matters."""

    def handler(req):
        url = str(req.url)
        if "/users/by-email" in url:
            if scooter_id is None:
                return httpx.Response(404)
            assert req.url.params.get("email") == email
            return httpx.Response(200, json={"id": scooter_id})
        return httpx.Response(200, json={"login": "octocat", "email": email})

    return handler


async def test_resolve_owner_full_chain(monkeypatch):
    monkeypatch.setattr(settings, "agent_host_url", "http://agent-host:8080", raising=False)
    _patch(monkeypatch, _chain_handler("a@x.io", "scooter-alice"))
    assert await lib_identity.resolve_owner("github", "octocat") == "scooter-alice"


async def test_resolve_owner_no_email(monkeypatch):
    _patch(monkeypatch, _chain_handler(None, "scooter-alice"))
    assert await lib_identity.resolve_owner("github", "octocat") is None


async def test_resolve_owner_no_scooter_match(monkeypatch):
    monkeypatch.setattr(settings, "agent_host_url", "http://agent-host:8080", raising=False)
    _patch(monkeypatch, _chain_handler("nobody@x.io", None))
    assert await lib_identity.resolve_owner("github", "octocat") is None


async def test_resolve_owner_empty_external_id(monkeypatch):
    assert await lib_identity.resolve_owner("github", "") is None


# --- privacy: personal data must not reach a structured log field ---------------


def test_pseudonym_is_stable_and_does_not_reveal_the_input():
    from scooter_lib.logging_config import pseudonym

    # Stable: the same principal always correlates across lines and across restarts.
    assert pseudonym("U123ABC") == pseudonym("U123ABC")
    # Distinct principals do not collide.
    assert pseudonym("U123ABC") != pseudonym("U999ZZZ")
    # The raw value never appears in the token.
    tok = pseudonym("alice@example.com")
    assert "alice" not in tok and "example.com" not in tok
    # Empty in, empty out — never the string "None" as a field value.
    assert pseudonym("") is None
    assert pseudonym(None) is None


@pytest.mark.asyncio
async def test_no_raw_identifier_reaches_a_log_field(monkeypatch, caplog):
    """No identifier reaches a log field raw — a structured field is searchable and
    inherits the log store's retention."""
    import logging as _logging

    from webhooks import identity_resolve as ir

    secret_id = "octocat-SECRET-LOGIN"

    class _Boom:
        def __init__(self, *a, **k):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def get(self, *a, **k):
            raise ir.httpx.HTTPError("upstream down")

    monkeypatch.setattr(ir.httpx, "AsyncClient", _Boom)

    with caplog.at_level(_logging.WARNING):
        await lib_identity.get_user_email("github", secret_id)

    assert caplog.records, "expected a warning to be logged"
    for rec in caplog.records:
        # The raw id must not be in the message OR in any structured field.
        assert secret_id not in rec.getMessage()
        for key, value in rec.__dict__.items():
            assert secret_id != value, f"raw identifier leaked as field {key}"
        # ...and the pseudonym must be there, so the line is still correlatable.
        # In its OWN field: this is the external identifier, not a Scooter user id.
        assert getattr(rec, "external_user", None) == lib_identity.pseudonym(secret_id)
        # user_id means the SCOOTER user and nothing else. Resolution never got that far
        # here, so it must be ABSENT rather than holding a token that joins to nothing.
        assert not hasattr(rec, "user_id")


@pytest.mark.asyncio
async def test_success_logs_the_pseudonymized_SCOOTER_id_not_the_external_one(monkeypatch, caplog):
    """The success line carries the Scooter id (what the rest of the system keys on),
    pseudonymized so a leaked log cannot be joined against a database dump."""
    import logging as _logging

    external = "octocat"
    email = "alice@example.com"
    db_user_id = "scooter-user-abc123"

    monkeypatch.setattr(settings, "agent_host_url", "http://agent-host:8080", raising=False)
    _patch(monkeypatch, _chain_handler(email, db_user_id))

    with caplog.at_level(_logging.INFO):
        got = await lib_identity.resolve_owner("github", external)

    assert got == db_user_id  # the caller still receives the real id
    rec = next(r for r in caplog.records if "resolved external user" in r.getMessage())

    # The logged id is the pseudonymized SCOOTER id...
    assert rec.user_id == lib_identity.pseudonym(db_user_id)
    # ...and NEITHER the raw db id, the external id, nor the email appears anywhere.
    for value in rec.__dict__.values():
        assert value not in (db_user_id, external, email)
