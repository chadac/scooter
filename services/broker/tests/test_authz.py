"""Authorizer seam — the no-op (FGA off) + the settings-driven builder.

The FgaAuthorizer (OpenFGA-backed) is exercised via the broker's integration
path, not here (no live OpenFGA in unit tests); these pin the SEAM behavior the
rest of the broker relies on.
"""

from __future__ import annotations

from broker.core.authz import (
    NoopAuthorizer,
    authorizer_from_settings,
    aws_account_object,
    user_object,
)


async def test_noop_allows_everything():
    a = NoopAuthorizer()
    assert await a.check(user="user:nobody", relation="approver", obj="aws_account:dev") is True
    # grant is a no-op (doesn't raise).
    await a.grant(user="user:nobody", relation="approver", obj="aws_account:dev")


def test_authorizer_from_settings_off_by_default():
    class S:  # no fga_* attrs at all
        pass

    assert isinstance(authorizer_from_settings(S()), NoopAuthorizer)


def test_authorizer_from_settings_noop_when_disabled():
    class S:
        fga_enabled = False
        fga_api_url = "http://fga:8080"
        fga_store_id = "store1"

    assert isinstance(authorizer_from_settings(S()), NoopAuthorizer)


def test_authorizer_from_settings_builds_fga_when_configured():
    class S:
        fga_enabled = True
        fga_api_url = "http://fga:8080"
        fga_store_id = "store1"
        fga_authorization_model_id = "model1"

    a = authorizer_from_settings(S())
    assert type(a).__name__ == "FgaAuthorizer"


def test_authorizer_from_settings_noop_when_url_or_store_missing():
    class S:
        fga_enabled = True
        fga_api_url = ""  # missing url -> can't build -> noop
        fga_store_id = "store1"

    assert isinstance(authorizer_from_settings(S()), NoopAuthorizer)


def test_object_id_helpers():
    assert aws_account_object("dev") == "aws_account:dev"
    assert user_object("alice@x.io") == "user:alice@x.io"


# --- finding #2 (HIGH): grant() must NOT swallow real FGA write failures -------
#
# A failed grant that's silently dropped (at DEBUG) means an approver tuple was
# never written; check() fails CLOSED, so the approver is permanently and silently
# locked out. grant() must re-raise everything EXCEPT a genuine duplicate-tuple
# no-op, so seed_approver_tuples' own loud handler can surface it.

import pytest  # noqa: E402

from broker.core.authz import FgaAuthorizer  # noqa: E402


class _FakeWriteClient:
    """Stand-in for OpenFgaClient whose write() raises a chosen exception."""

    def __init__(self, exc: Exception):
        self._exc = exc

    async def write(self, *_a, **_k):
        raise self._exc


def _fga_with_write_error(exc: Exception) -> FgaAuthorizer:
    a = FgaAuthorizer(api_url="http://fga:8080", store_id="s", model_id="m")
    a._client = _FakeWriteClient(exc)  # bypass _ensure_client (no real SDK in tests)
    return a


async def test_grant_reraises_real_write_failure():
    """An FGA-unreachable / wrong-store / network error must PROPAGATE, not be
    swallowed at DEBUG (else the approver is silently locked out)."""
    a = _fga_with_write_error(RuntimeError("connection refused"))
    with pytest.raises(RuntimeError, match="connection refused"):
        await a.grant(user="user:alice", relation="approver", obj="aws_account:dev")


async def test_grant_swallows_duplicate_tuple():
    """A genuine duplicate-tuple write IS an idempotent no-op (must not raise)."""
    a = _fga_with_write_error(
        Exception("write_failed_due_to_invalid_input: tuple already exists")
    )
    # Does not raise.
    await a.grant(user="user:alice", relation="approver", obj="aws_account:dev")
