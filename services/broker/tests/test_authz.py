"""The authorizer seam: the no-op, the settings-driven builder, and grant() error handling.

The "aws_account:dev" strings are opaque object ids, since the seam does not know what an
aws account is.
"""

from __future__ import annotations

from broker.core.authz import authorizer_from_settings
from scooter_broker_lib.authz import NoopAuthorizer, user_object


async def test_noop_allows_everything():
    a = NoopAuthorizer()
    assert await a.check(user="user:nobody", relation="approver", obj="aws_account:dev") is True
    await a.grant(user="user:nobody", relation="approver", obj="aws_account:dev")


def test_authorizer_from_settings_off_by_default():
    class S:
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
        fga_api_url = ""
        fga_store_id = "store1"

    assert isinstance(authorizer_from_settings(S()), NoopAuthorizer)


def test_object_id_helpers():
    assert user_object("alice@x.io") == "user:alice@x.io"


# --- grant() must not swallow real FGA write failures --------------------------

import pytest  # noqa: E402

from broker.core.authz import FgaAuthorizer  # noqa: E402


class _FakeWriteClient:
    """Stand-in for OpenFgaClient that records write() calls, optionally raising."""

    def __init__(self, exc: Exception | None = None):
        self._exc = exc
        self.calls: list[tuple] = []

    async def write(self, body, options=None):
        self.calls.append((body, options))
        if self._exc is not None:
            raise self._exc


def _fga_with_client(client: _FakeWriteClient) -> FgaAuthorizer:
    a = FgaAuthorizer(api_url="http://fga:8080", store_id="s", model_id="m")
    a._client = client  # bypass _ensure_client
    return a


async def test_grant_writes_with_on_duplicate_ignore():
    """Re-granting an existing tuple must not make OpenFGA log a 2017 write error."""
    from openfga_sdk.client.models import ClientWriteRequestOnDuplicateWrites

    client = _FakeWriteClient()
    await _fga_with_client(client).grant(user="user:alice", relation="approver", obj="aws_account:dev")

    (body, options), = client.calls
    assert [(t.user, t.relation, t.object) for t in body.writes] == [
        ("user:alice", "approver", "aws_account:dev")
    ]
    assert options["conflict"].on_duplicate_writes == ClientWriteRequestOnDuplicateWrites.IGNORE


async def test_grant_reraises_real_write_failure():
    """A real write error must propagate, since check() fails closed and the approver would be silently locked out."""
    a = _fga_with_client(_FakeWriteClient(RuntimeError("connection refused")))
    with pytest.raises(RuntimeError, match="connection refused"):
        await a.grant(user="user:alice", relation="approver", obj="aws_account:dev")


async def test_grant_reraises_invalid_input():
    """An invalid tuple must surface, not pass as an idempotent duplicate."""
    a = _fga_with_client(_FakeWriteClient(Exception("write_failed_due_to_invalid_input: unknown relation")))
    with pytest.raises(Exception, match="unknown relation"):
        await a.grant(user="user:alice", relation="aproover", obj="aws_account:dev")
