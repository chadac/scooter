# AWS Permissions Broker — Spec (PoC Stage 1: Research)

Dynamic, approval-gated AWS access for agents. The agent requests a scoped IAM
permission; a human approves; the broker provisions a short-lived dynamic IAM
role in a target account and vends ephemeral STS credentials. No static keys; no
standing access. Ported from the OpenHands `agent-token-broker`
(`~/code/gitlab.com/x.studio/devops/itops-infra/kubernetes/agent-token-broker/`),
adapted to this repo's broker (provider/transport/source) + per-conversation SA
identity.

## What we already have (and why the port is simpler here)

- **Identity is solved.** A sandbox proves its conversation via a projected SA
  token → K8s TokenReview → `Identity{conversation_id, namespace, service_account}`
  (`broker/core/auth.py`). The reference needed a shared API key + IP allowlist +
  a per-conversation session-token dance; we get all of that from the SA token
  for free. **No `agent_api_key` / `X-Session-Token` needed.**
- **Plugin model.** `Provider = source + transports`. The AWS broker is a new
  **transport** (`aws-permissions`) + a **source** (dynamic STS) + a small store.
- **An approval UI already exists** — the AG-UI interrupt + InterruptPanel
  (`ui/src/InterruptPanel.tsx`) and the conversation UI. The reference used a
  separate OIDC web dashboard; we can surface approvals in-product.

## Model (ported, mapped to our types)

**Request lifecycle** (from the reference, unchanged — it's well-designed):
`pending → approved → active → expired` with branches `→ denied`, `→ revoked`,
`approved → error`. Risk `low|medium|high` drives STS duration
(1h / 30m / 15m); the dynamic role has a longer TTL (default 12h) within which
the agent can refresh creds without re-approval.

**Request** (agent → broker): `{ target_account, policy_document?,
managed_policy_arns?, justification }` — `conversation_id` comes from the SA
token, NOT the body. Same free-form-IAM-policy + managed-ARN model as the
reference (no named templates).

**Guardrails (3 layers, ported verbatim — this is the security core):**
1. Structural validation (Version 2012-10-17, Allow-only, no `Action:"*"`, prod
   accounts reject `Resource:"*"` on writes + service-wide write wildcards).
2. Global deny-list (IAM priv-esc, audit/security tampering, KMS delete, org
   leave) — `BLOCKED_ACTIONS` + `BLOCKED_PATTERNS`.
3. Per-account allowlist (`allowed_policy`) — every requested action+resource
   must be covered. Plus a permission BOUNDARY on every dynamic role (the AWS
   hard ceiling).

**Provisioning (ported):** broker IRSA → `sts:AssumeRole` the target account's
`agent-token-broker-base` role (with `ExternalId`) → create dynamic policy +
role (trust = broker IRSA principal, boundary attached) → chained
`sts:AssumeRole` of the dynamic role → ephemeral STS creds (held in-memory,
never persisted). Cleanup: a 5-min sweeper tears down roles past `role_expires_at`;
revoke/deny tear down immediately.

## Decisions to confirm (the uncertainties)

1. **Approval surface.** The reference uses a standalone OIDC web dashboard.
   Options for us:
   (a) **In-conversation via the interrupt UI** — the agent's request becomes an
       AG-UI interrupt the user approves inline (reuses what we just built). But
       the *approver* is often NOT the agent's user, and approval needs an
       admin identity + audit, which the interrupt flow doesn't have.
   (b) **A separate approval UI** (like the reference) — admin-authenticated
       (OIDC), lists pending requests, approve/deny. Most faithful + correct for
       a real authz boundary, but new UI surface.
   (c) **Slack approval** — post to a channel, approve via the web link (the
       reference is notification-only over Slack; the *real* approve is the web
       UI). We have Slack wired already.
   → LIKELY: (b) a minimal admin approval surface, with (c) Slack notification.
   (a) is tempting for a demo but conflates requester and approver.

2. **Where the store + IAM live.** The reference is one FastAPI app. Here the
   broker is the natural home (it already holds credentials + per-conversation
   identity). Store = **the EXISTING Postgres** (`agent-webhooks-db` in the
   `agent-manager` namespace) — the broker runs in the same namespace so it
   reaches `agent-webhooks-db.agent-manager.svc.cluster.local:5432` over cluster
   DNS. Use a SEPARATE database (`broker`) on that instance so the two services
   don't collide, with the same DSN-from-components + secretKeyRef pattern the
   webhooks store uses (SQLAlchemy/asyncpg). No second Postgres pod. (SQLite
   stays the local/dev default.) See the storage-consolidation TODO below.

3. **Admin identity.** How does an approver authenticate? The reference uses ALB
   OIDC (JumpCloud). We have basic-auth on the chat ingress + (for webhooks) no
   auth. → NEEDS a decision: reuse the existing openhands OIDC/basic-auth, or a
   dedicated admin auth.

4. **Account registry + target-account infra.** The per-account
   `agent-token-broker-base` role + `agent-broker-permission-boundary` policy
   live in AWS (the reference manages them in a separate `aws-accounts-infra`
   repo). For a deployment we need: which account(s) to target, and those two IAM
   objects provisioned there with a trust policy naming OUR broker's IRSA role.
   → NEEDS the target account(s) + Terraform/manual setup. This is the main
   external dependency.

5. **Scope of the PoC.** Full port (multi-account, Slack, refresh, escalate,
   audit) vs. a minimal vertical slice (one account, request → approve →
   creds → expire) to prove the chain, then iterate.

## DECISIONS (confirmed)

- **Scope: full port MINUS Slack.** Multi-account registry, request/approve/deny,
  dynamic role+policy provisioning, chained STS, refresh, escalate, audit, the
  5-min cleanup sweeper, and all 3 guardrail layers. Slack notifications are
  DEFERRED (see TODO below).
- **Approval surface: in-conversation by default.** A permission request becomes
  an AG-UI INTERRUPT (reusing the InterruptPanel mechanism just built): the run
  pauses, the user sees the request (account, policy summary, risk) with
  Approve / Deny buttons inline, and answering resumes the agent with the vended
  creds (or a denial). Slack approval is a TODO.
  - NOTE on the authz caveat: in-conversation approval means the conversation's
    user is the approver. That's acceptable for the PoC/in-product flow; the
    "approver ≠ requester" admin model is what the configurable admin-auth +
    (future) dedicated/Slack approval address.
- **Admin auth: pluggable + deployer-configured.** The broker exposes an
  `is_admin(identity)` seam; WHO may approve is configured at deploy time (k8s).
  For the in-conversation flow the approver is the conversation user (validated
  by the same SA-token/identity path); a future admin UI/Slack flow plugs a
  different check in.

## Approval flow (in-conversation, the chosen default)

1. Agent calls a `request_aws_access` action (or POSTs the broker
   `/aws/request`) with `{target_account, policy_document/managed_policy_arns,
   justification}`. The broker validates (3 guardrail layers), eagerly creates
   the inline policy, stores the request `pending`, and returns a `request_id`.
2. The agent-host surfaces it as an **AG-UI interrupt** in the conversation
   (account + policy summary + risk + justification; options: Approve / Deny).
   The run BLOCKS (the agent is waiting on the broker request anyway).
3. The user picks Approve → the agent-host tells the broker
   `POST /aws/{id}/approve` (carrying the approver's identity); the broker
   provisions the dynamic role and flips to `active`.
4. The agent polls `GET /aws/{id}` → gets STS creds when `active`, and continues.
   Deny → the agent gets a denial and proceeds without the access.

This reuses the interrupt round-trip (RUN_FINISHED outcome=interrupt → resume)
end to end; the broker is the system of record for the request + creds.

## TODO (deferred)

- **Storage consolidation onto a single store.** We now have (or will have)
  several stores: the webhooks mapping DB (`agent-webhooks-db` Postgres), the
  agent-host conversation state (PVC, JSONL event log + meta), and this AWS
  permissions store. Consolidate onto ONE shared Postgres where it makes sense:
  the broker AWS store + the webhooks store share the same Postgres instance
  (different databases) as a first step. Longer-term, evaluate moving the
  agent-host conversation store onto Postgres too (vs. the per-conversation PVC),
  so there's one durable backend to operate/back up. The
  rename-`agent-webhooks-db`-to-something-neutral (it's becoming a shared DB, not
  webhooks-specific) is part of this.
- **Slack approval/notification.** Post the request to a channel and allow
  approve via a link or interactive buttons. The reference is notification-only
  over Slack (real approve is its web UI); we'd add either a link to a
  (future) admin UI or true Slack interactive approval. Out of scope for the
  first port.
- **Dedicated admin approval UI** (approver ≠ requester, audit dashboard) — the
  reference's OIDC web dashboard, if/when approvals need to leave the
  conversation.

## External dependency (AWS, the deployer must provision)

Per target account agents may request access to:
- A role `agent-token-broker-base` whose trust policy allows OUR broker's IRSA
  role to `sts:AssumeRole` with `ExternalId` (config), and whose permissions let
  it create/manage IAM roles+policies + chained `sts:AssumeRole` of the dynamic
  role.
- A permission-boundary policy `agent-broker-permission-boundary` (the hard
  ceiling on any vended credential).
- The broker's own IRSA role needs `sts:AssumeRole` on
  `arn:aws:iam::*:role/agent-token-broker-base` with the ExternalId condition.

The account registry (alias → {account_id, broker_role_arn, enabled,
allowed_policy, allowed_managed_policies}) is broker config (a mounted JSON, like
the reference's `accounts.json`).
