# The broker provider

The broker sits between the agent and every external API. A contrib's broker half is a
**provider**: a name, a credential, and one or more **transports**, which are the routes
the broker mounts under `/<name>/`. The agent calls them from its sandbox with the
`agent-broker` CLI, and the broker adds the credential to the outbound request. The
agent never holds the token.

## A provider factory

```python
# contrib/acme/scooter_contrib_acme/broker_provider.py
"""Acme provider: proxies /acme/* to the Acme API with the token added."""

from __future__ import annotations

from scooter_broker_lib.registry import register_provider
from scooter_broker_lib.sources.static_token import StaticTokenSource
from scooter_broker_lib.transports.http_proxy import HttpProxy
from scooter_broker_lib.types import Provider

from .config import AcmeSettings

UPSTREAM = "https://api.acme.example"


@register_provider
def acme() -> Provider:
    # Read once, when the broker builds its app.
    settings = AcmeSettings()
    token = settings.acme_token.strip()
    return Provider(
        name="acme",                                   # route prefix: /acme/*
        credential=StaticTokenSource(token=token),     # Authorization: Bearer <token>
        transports=[HttpProxy(upstream=UPSTREAM)],
        enabled=bool(token),                           # no token, no routes
    )
```

The factory name (`acme`) must be the contrib's name: the generated entry point
calls it. The broker calls every registered factory at startup and mounts the enabled
providers.

**Gate `enabled` on the credential.** A provider without its token should be absent, so
calls get a clear `404` instead of an upstream `401` that looks like a bug. Its
[skill](skills.md) can then say "a 404 means this deployment hasn't enabled Acme".

From the sandbox, the agent can now run:

```bash
agent-broker acme/v1/issues/ENG-42 | jq .title
```

## Credentials

`credential` is a `CredentialSource`, an object with
`async def get(self, identity) -> Credential`. The broker calls it per request, so a
source can mint short-lived tokens or choose one per conversation.

| Need | Use |
|---|---|
| A fixed bearer token | `StaticTokenSource(token=…)` |
| A fixed token in a custom header | `StaticTokenSource(token=…, kind="header", header_name="PRIVATE-TOKEN")` (as `contrib/gitlab` does) |
| Tokens minted on demand | Your own `CredentialSource`. `contrib/github` mints GitHub App installation tokens and `contrib/jira` runs an OAuth client-credentials flow |

`identity` is the caller the broker verified from the sandbox's signed token: its
`conversation_id`, `owner` and service account. Use it for per-user decisions. Never trust
an identity the agent passes as an argument.

## Transports

A provider can mount several transports. Put specific routes before the `HttpProxy`
catch-all.

| Transport | What it mounts |
|---|---|
| `HttpProxy(upstream=…)` | `/<name>/<path>`, forwarded to `upstream/<path>` with the credential |
| `ForgeHosts(hosts=…)` | Nothing under the prefix: registers hosts with the forge proxy, so `git`/`gh`/`glab` against them are authenticated in the sandbox |
| `McpTools(server=…, upstream=…)` | Typed agent tools ([Agent tools](tools.md)) |
| Your own `Transport` | Any FastAPI router: implement `routes(provider, authed) -> APIRouter` |

A custom transport takes `authed` as a dependency on every route, which authenticates the
caller and hands you its `Identity`:

```python
from dataclasses import dataclass

from fastapi import APIRouter, Depends

from scooter_broker_lib.types import AuthDependency, Identity, Provider, Transport


@dataclass
class AcmeWhoami(Transport):
    name: str = "whoami"

    def routes(self, provider: Provider, authed: AuthDependency) -> APIRouter:
        router = APIRouter()

        @router.get("/whoami")          # mounted at /acme/whoami
        async def whoami(identity: Identity = Depends(authed)) -> dict:
            return {"conversation": identity.conversation_id, "owner": identity.owner}

        return router
```

`contrib/echo/scooter_contrib_echo/broker_provider.py` is the reference version.

## Linking created resources

When the agent creates something through the proxy, such as an issue, the broker can
attach it to the conversation automatically. It then shows in the conversation's links
panel, and webhook events on it route back to this conversation. Give `HttpProxy`
**link rules**: a method, a path regex (without the `/acme/` prefix), and a function
that pulls the link out of the response body.

```python
from scooter_broker_lib.autolink import Link, rule

_LINK_RULES = [
    rule(
        "POST", r"^v1/issues/?$",
        lambda r: Link(source="acme", resource_type="issue", url=r.get("url", ""), title=r.get("title")),
    ),
]

HttpProxy(upstream=UPSTREAM, link_rules=_LINK_RULES, agent_host_url=settings.agent_host_url)
```

`agent_host_url` is where the link is posted. `ScooterBaseSettings` already reads it
from the environment.

## Human approvals

Some actions should wait for a person, such as granting cloud access. A contrib can raise
an **approval**: the agent asks, an Approve/Deny prompt appears in the conversation, and
the human's answer goes back to the contrib. The platform doesn't know what's being
approved. The contrib writes the message the human reads and decides who may answer.

That takes three pieces:

1. **Routes** on a custom transport: create a request, list pending ones, check whether
   this viewer may approve, and record the answer. `contrib/echo/scooter_contrib_echo/approvals.py`
   implements the whole protocol in one file, and `contrib/aws` is the production version.
2. **Where those routes are**, in `deployment.nix`, so the agent-host can relay answers:

    ```nix
    scooter.approvals.acme = {
      brokerPrefix = "/acme/approval";
      pendingPath = "/acme/approval/pending";   # replayed after a rollout
    };
    ```

3. **How the prompt looks**, in `contrib.nix`:

    ```nix
    approvals = {
      blockedTitle = "Only a project admin can approve this.";
      blockedHint = "You can't approve this Acme request. Ask a project admin.";
    };
    ```

Next: [agent tools](tools.md).
