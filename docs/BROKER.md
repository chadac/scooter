# Credential Broker — Design

> Status: **Design** (module architecture + interfaces; refining before impl).
> Service lives at `services/broker/` (Python/FastAPI, lifted from openhands-nix
> and refactored for extensibility).

## 1. Purpose

A credential broker so agents can act against external systems (GitHub, GitLab,
Jira, Slack, …) **without ever holding raw secrets**. The agent's credentialed
work runs **in the sandbox pod** (via K8s exec); the pod authenticates to the
broker with its **projected per-conversation ServiceAccount token**; the broker
injects/vends the real credential. The agent-host holds nothing.

This preserves the openhands-nix model under our agent-OUTSIDE architecture
(see [[broker-auth-per-conversation-sa]]): the locus of credentialed actions is
still the pod, so the auth boundary is unchanged.

## 2. Core idea: provider modules + pluggable transports

The broker is **not** a fixed set of `/github`, `/gitlab` routes. It is a
**registry of provider modules**. Adding an integration (or a new *injection
method*) is a drop-in module, never a core edit.

A **Provider module** bundles two things:

1. **A credential source** — how it obtains the secret (GitHub App JWT →
   installation token, static PAT, OAuth client-credentials, …). Pluggable so
   the same provider can swap sources.
2. **The transport(s) it supports** — *how* the credential is delivered. The
   transports are a **shared library**; a module declares which it offers and
   with what config. This is the "other injection methods" extension axis.

```
                ┌─────────── broker core (registry + auth) ───────────┐
   pod ──SA──►  │  TokenReview → identity (sandbox-{convId})          │
   token        │  for each registered Provider:                      │
                │    for each Transport it declares: mount handler    │
                └──────────────────┬──────────────────────────────────┘
                                   │
   Provider("github") = {          ▼
     credential: GitHubAppSource | PatSource,
     transports: [ HttpProxy(upstream=api.github.com),
                   GitCredential(host=github.com) ],
   }
```

## 3. Transports (the injection methods)

A **Transport** defines a delivery mechanism. The library ships:

- **`http-proxy`** — transparent reverse proxy. Mounts
  `/{provider}/{path}`; injects the credential into the outbound request to the
  module's `upstream`; the agent sees normal API responses, never the token.
  (Today's openhands-nix model.)
- **`git-credential`** — vends a git credential blob. Mounts
  `/{provider}/git-credentials`; returns `{protocol, host, username, password}`
  for the in-pod `git-credential-broker` helper. (Generalizes the openhands-nix
  `/git-credentials` special case.)
- **`token-vend`** — returns a short-lived raw token to an authorized caller
  (`/{provider}/token`). For callers that must hold the token briefly.

- **`whoami`** — diagnostic/test transport. Mounts `/{provider}/whoami`;
  authenticates the caller exactly like every real transport, **records the
  call**, and returns the validated `Identity` (no real credential). Backs the
  built-in `test` provider used for end-to-end credential-path tests (see §11).

Future transports (the point of the abstraction): `env-inject`, `file-mount`,
`sidecar`, provider-specific webhooks, etc. — added without touching the core.

### Transport interface (sketch)

```python
class Transport(Protocol):
    name: str                      # "http-proxy" | "git-credential" | ...
    def routes(self, provider: "Provider") -> list[Route]: ...
    # Each route handler: authenticate (core dep) -> provider.credential.get()
    #                     -> deliver per this transport's mechanism.
```

## 4. Credential sources

```python
class CredentialSource(Protocol):
    async def get(self, identity: Identity) -> Credential: ...
    #   identity = the validated pod SA identity (conv id, namespace).
    #   Credential = { kind, value, expires_at, inject(headers)->headers }
```

Shipped sources: `GitHubAppSource` (JWT→installation token, cached),
`StaticTokenSource` (PAT / bot token), `AtlassianOAuthSource` (client-creds).

## 5. Provider module

```python
@register_provider                 # plugin registry: auto-discovered on import
def github() -> Provider:
    return Provider(
        name="github",
        credential=GitHubAppSource() if app_configured() else StaticTokenSource(...),
        transports=[
            HttpProxy(upstream="https://api.github.com"),
            GitCredential(host="github.com", username="x-access-token"),
        ],
    )
```

The module owns its **upstream URL(s)** (not global config). Config supplies
**secrets + enable/disable** only.

## 6. Registry & discovery

- Modules **self-register** via `@register_provider` (or a Python entry-point so
  external packages can add providers).
- The broker core, on startup, discovers all registered providers, and for each
  enabled one mounts every transport's routes. **Adding a provider never edits
  the core.**
- Config gates which providers are active and injects their secrets.

## 7. Auth (unchanged from openhands-nix)

- The pod presents its **projected SA token** (audience `agent-broker`).
- Broker validates via **K8s TokenReview**, extracts identity from the SA
  username `system:serviceaccount:{ns}:sandbox-{convId}` → `Identity{convId}`.
- **Self-contained:** scoping is by SA identity only. `inspect_request` hooks
  exist on the transport pipeline for future fine-grained scope checks, backed
  by an allow-all resolver for now (no agent-host coupling).

## 8. Request flow (git push example)

```
agent-host -- exec `git push` --> sandbox pod
  pod git -> git-credential-broker helper
    helper reads projected SA token, GET broker /github/git-credentials
      broker: TokenReview -> identity sandbox-{convId}
      broker: provider github -> GitHubAppSource.get() -> installation token
      broker: GitCredential transport -> {username:x-access-token, password:token}
    helper hands creds to git -> git push to GitHub
```

The agent never sees the token; the agent-host is not involved.

## 9. Layout (`services/broker/`)

```
services/broker/
  broker/
    core/        registry, auth (TokenReview), app factory
    transports/  http_proxy.py, git_credential.py, token_vend.py
    sources/     github_app.py, static_token.py, atlassian_oauth.py
    providers/   github.py, gitlab.py, jira.py, slack.py  (each @register_provider)
    config.py
  tests/
  default.nix    pyproject.toml
```

## 11. End-to-end credential testing (UI-driven)

The broker ships a built-in **`test` provider** (`echo.py`) exposing the
**`whoami`** transport at `/test/whoami`. It carries no secret but enforces the
exact same SA-token auth as every real provider, records the call, and returns
the validated `Identity`.

This makes the credential path testable **entirely through the UI**, and easy to
extend with new scenarios:

```
e2e (Playwright):
  open UI -> send a prompt that makes the dummy agent run a tool that
    curls the broker: GET $BROKER_URL/test/whoami with the pod's SA token
  -> the agent's reply (in the UI) contains the broker's response
  -> assert: broker authenticated the caller as sandbox-{thisConversationId}
             (right conversation_id / service account / IRSA), and recorded the
             call. The whole UI -> agent -> pod -> broker -> back loop is proven.
```

The dummy ACP agent (`services/agent-host/src/fakeAgent.ts`) grows a scripted
"call the broker" turn (or honors a prompt keyword) so a test just sends a
message and asserts on the rendered result. Adding a future credential test =
add a provider/transport + a prompt that exercises it; no new harness.

Tiers: the *contract* (whoami auth, recorder) is unit-testable without a cluster;
the *full IRSA round-trip* (real SA token, TokenReview) is a Tier-2/3 test on the
kind cluster with the broker deployed.

## 10. Open / deferred

- **Language:** reuse Python/FastAPI as-is (decided). The refactor is internal
  structure, not a rewrite.
- **Fine-grained scopes** (which repos a conversation may touch): interface hook
  now (`inspect_request`), real scope store deferred.
- **kubenix:** a `modules/broker.nix` Deployment + the per-conversation Sandbox
  template already projects the broker-audience SA token + sets `BROKER_URL`
  (see modules/conversation.nix). The `git-credential-broker` shim is baked into
  the sandbox image.
```
