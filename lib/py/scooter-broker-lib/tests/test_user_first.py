"""UserFirstSource uses the owner's credential only where it may, and falls back otherwise."""

from __future__ import annotations

from scooter_broker_lib.owner import OwnerResolver
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.sources.user_first import UserFirstSource
from scooter_broker_lib.types import Credential, Identity

VIEWS = {
    "priv": {"owner": "alice", "visibility": "private"},
    "priv-bob": {"owner": "bob", "visibility": "private"},
    "shared": {"owner": "alice", "visibility": "shared"},
}


async def fetch(conv: str):
    return VIEWS.get(conv)


async def user_cred(user: str) -> Credential | None:
    if user == "alice":
        return Credential(kind="bearer", value="alice-token")
    if user == "carol":
        raise RuntimeError("row unreadable")
    return None


def source() -> UserFirstSource:
    return UserFirstSource(
        resolver=OwnerResolver(fetch),
        user_credential=user_cred,
        fallback=StaticTokenSource(token="app-token"),
    )


def ident(conv: str) -> Identity:
    return Identity(conversation_id=conv, namespace="ns", service_account="sa")


async def test_the_owner_s_token_in_their_private_conversation():
    cred = await source().get(ident("priv"))
    assert cred.value == "alice-token"
    assert cred.meta["acting_as"] == "alice"


async def test_the_deployment_token_in_a_shared_conversation():
    cred = await source().get(ident("shared"))
    assert cred.value == "app-token"
    assert "acting_as" not in cred.meta


async def test_the_deployment_token_when_the_owner_linked_nothing():
    assert (await source().get(ident("priv-bob"))).value == "app-token"


async def test_the_deployment_token_when_the_user_lookup_fails():
    VIEWS["priv-carol"] = {"owner": "carol", "visibility": "private"}
    assert (await source().get(ident("priv-carol"))).value == "app-token"


async def test_the_request_reaches_the_fallback():
    seen = []

    class Recording:
        async def get(self, identity, request=None):
            seen.append(request)
            return Credential(kind="bearer", value="app-token")

    src = UserFirstSource(resolver=OwnerResolver(fetch), user_credential=user_cred, fallback=Recording())
    marker = object()
    await src.get(ident("shared"), marker)  # type: ignore[arg-type]
    assert seen == [marker]
