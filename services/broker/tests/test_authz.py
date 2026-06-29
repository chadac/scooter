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
