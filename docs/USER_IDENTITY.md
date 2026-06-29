# User identity + authorization — design

Status: **DESIGN (for review)**. Adds (a) per-user conversations (you see only
your own) and (b) authorization-gated actions (who may approve the AWS broker
requests), built on a real ReBAC system so it scales beyond these two cases.

## Decisions (confirmed with the user)

1. **Auth source = a trusted identity HEADER from the ingress.** The app stays
   auth-source-agnostic: a deployer puts OIDC-proxy / basic-auth / forward-auth
   at the ingress and configures it to inject an identity header. The agent-host
   reads it; it does NOT do login/OIDC/sessions itself.
2. **No-header → anonymous (always allow).** A missing header is the single
   `anonymous` user. Preserves today's single-user behavior for local dev / the
   fake-agent e2e stack; enforcement is the ingress's job.
3. **Authorization = OpenFGA (ReBAC / Google Zanzibar).** Relationships, not a
   hardcoded allowlist. Extends to teams/orgs/per-resource/agent boundaries later.
4. **Conversations are PUBLIC by default.** "See only my own" is a VIEW FILTER
   (sidebar defaults to *mine*, with a toggle to *all*), NOT an access boundary.
   So ownership is org/UX, and per-conversation routes do NOT 403 on viewer —
   they stay open. (A private/owner-only escape hatch can come later if wanted.)
5. **The BROKER is the policy enforcement point.** Authorization checks that gate
   credentials/permissions happen in the broker (Python, `openfga-sdk`), not the
   agent-host. Rationale: the broker already holds per-conversation SA identity +
   vends credentials, and FUTURE work gives AGENTS their own permission
   boundaries (can this conversation/agent request scope X?) — those belong at
   the same enforcement point as "can this human approve?". The agent-host
   *relays the real user id*; the broker *decides*.
6. **AWS approvers seeded from deploy config** (approver ids/emails per account →
   OpenFGA tuples at deploy). Admin UI to manage them is later.
7. **Webhook-spawned conversation ownership: deferred** (stays unowned for now).

## Identity: the header seam

- New config: `AUTH_USER_HEADER` (default `x-auth-user`) and optionally
  `AUTH_EMAIL_HEADER` (default `x-auth-email`). The agent-host reads these off
  each request.
- A `UserContext = { id: string; email?: string; anonymous: boolean }`.
  - Header present → `{ id: <header>, anonymous: false }`.
  - Header absent → `{ id: "anonymous", anonymous: true }`.
- Wired in one place: a small helper in `agui/server.ts` / `router.ts` that
  extracts the `UserContext` from `req.headers` and passes it to handlers (the
  router's `Ctx` gains `user`). No per-route boilerplate.
- The header is trusted because the ingress is the trust boundary (the same
  posture the app already takes — it trusts the ingress today, just without
  identity). Document clearly: **the agent-host must not be exposed without an
  ingress that sets/strips this header**, or anyone can spoof it.

## Two separable pieces

Because conversations are public (view-filter, not access-gate), the agent-host
side needs NO authorization engine — just identity + an `owner` field + a filter.
OpenFGA lives ONLY at the broker (the enforcement point). This cleanly splits the
work:

- **Agent-host (identity + ownership view-filter):** no OpenFGA dependency.
- **Broker (OpenFGA enforcement):** the `approver` gate + future agent boundaries.

### Agent-host: identity + ownership (no OpenFGA)
- `ConversationMeta` + `Conversation` gain `owner?: string` (same shape as the
  recent `model` field): `saveMeta` / `listConversations` / `hydrate` carry it.
- `start(threadId, model, owner?)` sets `meta.owner = user.id` on create.
- `GET /conversations?scope=mine|all` (default `mine`): filters `sessions.list()`
  to `owner === user.id` when `scope=mine`; returns all when `scope=all`. A
  conversation with `owner == null` (pre-migration / webhook) counts as public —
  shown under `all`, and also under `mine` for `anonymous` so dev is unchanged.
  This is a VIEW filter; no 403s, nothing is hidden as a security measure.
- Per-conversation routes + `/agui` are UNCHANGED (public). Owner is just stamped
  + shown.
- UI: a "Mine / All" toggle in the sidebar (default Mine) flips `?scope=`.

### Broker: OpenFGA (the enforcement point)

**Deployment**
- A new `openfga` Deployment + Service in `modules/` (kubenix), backed by the
  shared Postgres (`agent-shared-db`, a new `openfga` database) — same pattern as
  the broker/webhooks stores. In-memory datastore for local/e2e.
- The broker gets `openfga-sdk` (Python) + `FGA_API_URL` / `FGA_STORE_ID` /
  `FGA_MODEL_ID` config. OFF by default: no FGA configured → the gate is skipped
  (allow), so the broker behaves as today until FGA is wired.

**Model (DSL)** — minimal now, room to grow:
```
model
  schema 1.1
type user
type aws_account
  relations
    define approver: [user]    # who may approve AWS requests for this account
# FUTURE: type agent / conversation with permission-boundary relations, checked
# here when an agent requests a credential scope.
```

**Broker Authorizer seam** (Python) — a thin interface so the broker core never
imports the SDK directly and "FGA off" is a clean allow:
```python
class Authorizer(Protocol):
    async def check(self, user: str, relation: str, obj: str) -> bool: ...
class NoopAuthorizer:        # FGA unset -> allow (today's behavior)
    async def check(self, *a) -> bool: return True
class FgaAuthorizer:         # backed by openfga-sdk
    ...
```

**Where the broker checks**
- AWS approve/deny (`broker/transports/aws_permissions.py`): before approving,
  `await authz.check(approver_user, "approver", f"aws_account:{account}")` →
  403 if false. The `approver_user` comes from the request body (relayed by the
  agent-host) but is now ENFORCED by the broker, not trusted.
- The existing SA-token `is_approver` gate stays (the agent-host SA is still the
  only service allowed to relay approvals) — OpenFGA adds the WHICH-HUMAN layer
  on top. So: SA-token proves "this is the agent-host relaying"; OpenFGA proves
  "this human may approve this account".
- `approved_by` is recorded as the real user id (replacing the
  `"conversation-user"` constant).

**Agent-host → broker**: `resolveAwsRequest` sends `approver: <user.id>` (the
real header identity) instead of the constant. That's the only agent-host change
for the broker path.

**Approver tuples**: seeded at deploy from config (`broker.aws.approvers` per
account → OpenFGA `write` tuples on startup, or a small seed job). No admin UI yet.

## What the UI does
- Nothing for identity (the ingress injects the header; the browser request
  carries it). A **Mine / All** toggle in the sidebar flips `GET /conversations
  ?scope=`, default Mine. Optionally show the current user somewhere.

## Migration / safety
- **Agent-host:** owner is additive. Default `scope=mine` shows yours; null-owner
  conversations (existing / webhook) are PUBLIC → appear under `all` (and under
  `mine` for `anonymous`). Nothing is hidden as security. Zero-risk.
- **Broker:** FGA unconfigured → the gate is skipped (allow) → identical to
  today. Turn on per-deployment via `FGA_*` + the approver tuples. The SA-token
  `is_approver` check is unchanged, so even with FGA off the agent-host is still
  the only relayer.

## Build order (two PRs)
1. **Agent-host identity + ownership view-filter** (no OpenFGA): header →
   UserContext, `owner` field, `?scope=` filter, UI toggle. Ships the visible
   "my conversations" win with no new infra.
2. **Broker OpenFGA enforcement:** the `openfga` Deployment, the Python
   Authorizer + `aws_account.approver` gate, deploy-config approver seeding, and
   the agent-host relaying the real user id. Ships the security gate.

## Tests
- Agent-host contract: header → UserContext (present/absent/anonymous);
  `GET /conversations?scope=mine|all` filters by owner; create stamps owner. (No
  OpenFGA needed — Tier 1.)
- Broker contract: `FgaAuthorizer` gate on approve (allowed/denied) against a
  fake/in-memory FGA; SA-token + FGA layered (both required); `approved_by` =
  real user; FGA-off → allow.
- e2e: two simulated users (different `x-auth-user`) — sidebar Mine shows
  disjoint lists, All shows both.
- Cluster (Tier 2, later): a real OpenFGA against Postgres.

## Settled (was open)
- Null-owner conversations → **PUBLIC** (public-by-default; confirmed).
- Conversation visibility is a **view filter**, not access control (confirmed).
- Approver tuples → **deploy-config seeded** (confirmed).
- Broker is the **enforcement point** (OpenFGA on the Python side), to also cover
  future agent permission boundaries (confirmed).
```
