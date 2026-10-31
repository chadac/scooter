"""Acting as the user on GitLab: an OAuth application (or a pasted PAT), SSH key registration and commit identity."""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx
from sqlalchemy.orm import DeclarativeBase

from scooter_broker_lib.commit_identity import Person
from scooter_broker_lib.ssh_keys import SshKeyChange, public_key
from scooter_broker_lib.store import StoreConfig
from scooter_broker_lib.types import Credential
from scooter_broker_lib.user_auth import Forge, ForgeAuthError, Profile, UserAuth, user_token_table
from scooter_broker_lib.user_secrets import SecretBox

SSH_KEY_TITLE = "Scooter"


class Base(DeclarativeBase):
    pass


GitLabUserToken = user_token_table(Base, "gitlab_user_tokens")


def noreply_email(host: str, user_id: int, username: str) -> str:
    return f"{user_id}-{username}@users.noreply.{host}"


def _key_material(line: str) -> str:
    """`type base64`, without the comment."""
    return " ".join(line.split()[:2])


@dataclass
class GitLabUsers:
    """The GitLab calls user auth needs."""

    host: str
    client_id: str = ""
    client_secret: str = ""
    transport: httpx.AsyncBaseTransport | None = None

    def _client(self, token: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=f"https://{self.host}/api/v4",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
            transport=self.transport,
        )

    async def profile(self, token: str) -> Profile:
        async with self._client(token) as c:
            resp = await c.get("/user")
        if resp.status_code in (401, 403):
            raise ForgeAuthError("the token was refused")
        resp.raise_for_status()
        body = resp.json()
        username = body["username"]
        return Profile(
            login=username,
            name=body.get("name") or username,
            email=noreply_email(self.host, body["id"], username),
        )

    async def revoke(self, token: str) -> None:
        async with httpx.AsyncClient(timeout=15, transport=self.transport) as c:
            resp = await c.post(
                f"https://{self.host}/oauth/revoke",
                data={"client_id": self.client_id, "client_secret": self.client_secret, "token": token},
            )
        resp.raise_for_status()

    async def add_ssh_key(self, token: str, key_line: str) -> None:
        async with self._client(token) as c:
            resp = await c.post(
                "/user/keys", json={"title": SSH_KEY_TITLE, "key": _key_material(key_line), "usage_type": "auth"}
            )
        # 400 is "has already been taken", which is the state we want.
        if resp.status_code not in (201, 400):
            resp.raise_for_status()

    async def remove_ssh_key(self, token: str, key_line: str) -> None:
        want = _key_material(key_line)
        async with self._client(token) as c:
            resp = await c.get("/user/keys", params={"per_page": 100})
            resp.raise_for_status()
            for key in resp.json():
                if _key_material(key.get("key", "")) == want:
                    (await c.delete(f"/user/keys/{key['id']}")).raise_for_status()

    def forge(self, redirect_uri: str) -> Forge:
        return Forge(
            name="gitlab",
            label="GitLab",
            authorize_url=f"https://{self.host}/oauth/authorize",
            token_url=f"https://{self.host}/oauth/token",
            client_id=self.client_id,
            client_secret=self.client_secret,
            redirect_uri=redirect_uri,
            scopes=("api",),
            profile=self.profile,
            # GitLab takes OAuth tokens and PATs alike as bearer.
            credential=lambda token: Credential(kind="bearer", value=token),
            revoke=self.revoke if self.client_id and self.client_secret else None,
            transport=self.transport,
        )


@dataclass
class GitLabBot:
    """The deployment token's own account, for commits made as the deployment."""

    users: GitLabUsers
    token: str
    _person: Person | None = field(default=None, repr=False)

    async def person(self) -> Person:
        if self._person is None:
            profile = await self.users.profile(self.token)
            self._person = Person(profile.name, profile.email)
        return self._person


def build(config: StoreConfig, box: SecretBox, users: GitLabUsers, redirect_uri: str) -> UserAuth:
    auth = UserAuth(forge=users.forge(redirect_uri), table=GitLabUserToken, config=config, box=box)

    async def register_key(user: str, token: str) -> None:
        key = await public_key(user)
        if key:
            await users.add_ssh_key(token, key)

    auth.on_linked.append(register_key)
    return auth


async def on_key_change(auth: UserAuth, users: GitLabUsers, change: SshKeyChange) -> None:
    """Keep the user's GitLab account trusting their current Scooter key and no older one."""
    token = await auth.access_token(change.user)
    if token is None:
        return
    if change.old:
        await users.remove_ssh_key(token, change.old)
    await users.add_ssh_key(token, change.new)
