"""Acting as the user on GitHub: the App's user-to-server OAuth flow (or a pasted PAT), SSH key registration and commit identity.

A user token can do what both the App's permissions and the user's own access
allow, on repos where the App is installed; a fine-grained PAT reaches the rest.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import httpx

from scooter_broker_lib.commit_identity import Person
from scooter_broker_lib.ssh_keys import SshKeyChange, public_key
from scooter_broker_lib.store import StoreConfig
from scooter_broker_lib.types import Credential
from scooter_broker_lib.user_auth import Forge, ForgeAuthError, Profile, UserAuth
from scooter_broker_lib.user_auth import user_token_table
from scooter_broker_lib.user_secrets import SecretBox
from sqlalchemy.orm import DeclarativeBase

from .forge import DOTCOM, api_base
from .github_app import GitHubAppSource

logger = logging.getLogger(__name__)

_HEADERS = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
SSH_KEY_TITLE = "Scooter"


class Base(DeclarativeBase):
    pass


GitHubUserToken = user_token_table(Base, "github_user_tokens")


def noreply_email(host: str, user_id: int, login: str) -> str:
    domain = "users.noreply.github.com" if host == DOTCOM else f"users.noreply.{host}"
    return f"{user_id}+{login}@{domain}"


def _key_material(line: str) -> str:
    """`type base64`, without the comment GitHub drops."""
    return " ".join(line.split()[:2])


@dataclass
class GitHubUsers:
    """The GitHub calls user auth needs, against github.com or a GHES host."""

    host: str
    client_id: str = ""
    client_secret: str = ""
    transport: httpx.AsyncBaseTransport | None = None

    @property
    def api(self) -> str:
        return api_base(self.host)

    def _client(self, token: str | None = None) -> httpx.AsyncClient:
        headers = dict(_HEADERS)
        if token:
            headers["Authorization"] = f"Bearer {token}"
        return httpx.AsyncClient(base_url=self.api, headers=headers, timeout=15, transport=self.transport)

    async def profile(self, token: str) -> Profile:
        async with self._client(token) as c:
            resp = await c.get("/user")
        if resp.status_code in (401, 403):
            raise ForgeAuthError("the token was refused")
        resp.raise_for_status()
        body = resp.json()
        login = body["login"]
        return Profile(login=login, name=body.get("name") or login, email=noreply_email(self.host, body["id"], login))

    async def revoke(self, token: str) -> None:
        async with httpx.AsyncClient(timeout=15, transport=self.transport) as c:
            resp = await c.request(
                "DELETE",
                f"{self.api}/applications/{self.client_id}/grant",
                auth=(self.client_id, self.client_secret),
                headers=_HEADERS,
                json={"access_token": token},
            )
        if resp.status_code not in (204, 404, 422):
            resp.raise_for_status()

    async def add_ssh_key(self, token: str, key_line: str) -> None:
        async with self._client(token) as c:
            resp = await c.post("/user/keys", json={"title": SSH_KEY_TITLE, "key": _key_material(key_line)})
        # 422 is "key is already in use", which is the state we want.
        if resp.status_code not in (201, 422):
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
            name="github",
            label="GitHub",
            authorize_url=f"https://{self.host}/login/oauth/authorize",
            token_url=f"https://{self.host}/login/oauth/access_token",
            client_id=self.client_id,
            client_secret=self.client_secret,
            redirect_uri=redirect_uri,
            # A GitHub App's user token carries the App's permissions, not scopes.
            scopes=(),
            profile=self.profile,
            credential=lambda token: Credential(kind="bearer", value=token),
            revoke=self.revoke if self.client_id and self.client_secret else None,
            transport=self.transport,
        )


@dataclass
class GitHubBot:
    """The App's bot account, for commits made as the deployment."""

    app: GitHubAppSource
    host: str
    transport: httpx.AsyncBaseTransport | None = None
    _person: Person | None = field(default=None, repr=False)

    async def person(self) -> Person:
        if self._person is None:
            api = api_base(self.host)
            async with httpx.AsyncClient(timeout=15, headers=_HEADERS, transport=self.transport) as c:
                app = await c.get(f"{api}/app", headers={"Authorization": f"Bearer {self.app._generate_jwt()}"})
                app.raise_for_status()
                login = f"{app.json()['slug']}[bot]"
                user = await c.get(f"{api}/users/{login}")
                user.raise_for_status()
            self._person = Person(name=login, email=noreply_email(self.host, user.json()["id"], login))
        return self._person


def build(config: StoreConfig, box: SecretBox, users: GitHubUsers, redirect_uri: str) -> UserAuth:
    auth = UserAuth(forge=users.forge(redirect_uri), table=GitHubUserToken, config=config, box=box)

    async def register_key(user: str, token: str) -> None:
        key = await public_key(user)
        if key:
            await users.add_ssh_key(token, key)

    auth.on_linked.append(register_key)
    return auth


async def on_key_change(auth: UserAuth, users: GitHubUsers, change: SshKeyChange) -> None:
    """Keep the user's GitHub account trusting their current Scooter key and no older one."""
    token = await auth.access_token(change.user)
    if token is None:
        return
    if change.old:
        await users.remove_ssh_key(token, change.old)
    await users.add_ssh_key(token, change.new)
