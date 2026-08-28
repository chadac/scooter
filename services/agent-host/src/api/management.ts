/**
 * Management API — REST surface for managing conversations.
 *
 * Wraps the SessionManager with conversation CRUD + lifecycle + history. The
 * AG-UI streaming endpoint (POST /agui) stays the assistant-ui transport; this
 * adds the management routes around it on the same node:http server.
 *
 *   GET    /conversations                  list
 *   POST   /conversations                  create {threadId?, title?}
 *   GET    /conversations/:id              get + status
 *   DELETE /conversations/:id              end (destroy sandbox)
 *   POST   /conversations/:id/suspend
 *   POST   /conversations/:id/resume
 *   POST   /conversations/:id/messages     prompt {text}
 *   GET    /conversations/:id/events       SSE stream
 *   GET    /conversations/:id/history      the event log
 *   POST   /conversations/:id/permission/:toolCallId  {optionId}
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createRouter, type Router, type ResolveUser } from "../http/router.js";
import type { SessionManager, Conversation } from "../session/manager.js";
import type { ConversationStore, ChecksummedEvent, ConversationLink } from "../session/manager.js";
import type { SessionId } from "../types.js";
import { tailByRuns } from "../session/eventWindow.js";
import type { AguiServer } from "../agui/server.js";
import type { WebServiceRegistry } from "../proxy/webServiceProxy.js";
import type { ModuleRegistry } from "../proxy/moduleRegistry.js";
import type { IdentityStore } from "../auth/identityStore.js";
import type { AssetStore } from "../session/assetStore.js";
import type { SchedulerClient } from "../agent/schedulerTools.js";
import type { SandboxResources } from "../session/resources.js";
import type { AguiEvent, ApproverIdentity, SessionBridge } from "../bridge.js";
import { logger } from "../log.js";
import { EMPTY_CHECKSUM, chainAll } from "../agui/integrity.js";

const log = logger("agent-host");
const remoteAgentLog = logger("remote-agent");

/** Public (JSON-safe) view of a conversation — omits the in-memory bridge.
 *  Exposes activity metadata (lastActivityAt, idleMs, ageMs) so the UI and any
 *  external lifecycle manager can reason about idleness. */
function view(c: Conversation, now = Date.now()) {
  return {
    id: c.id,
    threadId: c.threadId,
    status: c.status,
    title: c.title,
    createdAt: c.createdAt,
    lastActivityAt: c.lastActivityAt,
    idleMs: Math.max(0, now - c.lastActivityAt),
    ageMs: Math.max(0, now - c.createdAt),
    model: c.model,
    owner: c.owner,
    // The spawning conversation, when this is a subagent (undefined = top-level).
    // The UI nests children under their parent + shows subagent chips.
    parentId: c.parentId,
    // The title is user-set (renamed) — the UI shows it as pinned and the agent's
    // <title> no longer overrides it.
    userTitled: c.userTitled ?? false,
    // Starred by the user (UI highlight + future retention exemption).
    starred: c.starred ?? false,
    sandbox: { name: c.sandbox.name, namespace: c.sandbox.namespace },
  };
}

export interface ManagementDeps {
  sessions: SessionManager;
  store: ConversationStore;
  /** Who serves this conversation's LIVE stream. "elsewhere" => another pod owns it, so
   *  this pod's integrity stream would replay history and then sit silent forever (live
   *  appends land on the OWNER's local store). Streams opened before the controller
   *  assigned an owner land on a random pod ~half the time and stayed there — the
   *  Tier-2 "no tool card / Working… forever" coin-flip. Optional: absent =
   *  single-replica, everything is "mine". */
  streamOwnership?: (id: string) => Promise<"mine" | "elsewhere" | "unknown">;
  server: AguiServer;
  /** Answer a pending tool permission (wired to the bridge in index.ts). `approver`
   *  is the identity of the human answering (for an AWS interrupt, the broker
   *  authorizes them). */
  answerPermission: (sessionId: string, toolCallId: string, optionId: string, approver?: ApproverIdentity) => Promise<void>;
  /** Approve/deny a broker AWS request after the user answers the interrupt
   *  (POSTs to the broker's /aws/{id}/approve|deny). `approver` is the identity of
   *  the human who answered — the broker authorizes the configured claim
   *  (email/id/name) via OpenFGA. Optional. Returns the broker's error detail (a
   *  provisioning failure) so the caller can feed it back to the agent. */
  resolveAwsRequest?: (
    sessionId: string,
    requestId: string,
    approved: boolean,
    approver: ApproverIdentity,
  ) => Promise<void>;
  /** Read-only: may `approver` (the VIEWING user) approve this AWS request? Powers
   *  the UI's greyed-out Approve button. Per-viewer — the interrupt is raised once
   *  server-side but seen by many users. Fails closed (false) broker-side. Optional
   *  (defaults to allowed when unwired / no broker). */
  canApproveAwsRequest?: (
    sessionId: string,
    requestId: string,
    approver: ApproverIdentity,
  ) => Promise<boolean>;
  /** Model catalog for per-conversation selection: the host default + the set
   *  offered to clients (+ optional per-model hints). Empty list = only the
   *  default is selectable. */
  models?: {
    default?: string;
    available: string[];
    hints?: Record<string, string>;
    /** model id -> provider tags offering it ([] = every provider). */
    providers?: Record<string, string[]>;
  };
  /** Raw handler for the agent-self-modify MCP endpoint (goose's
   *  modify_environment tool). It writes the response itself (the MCP transport
   *  streams), so it takes req/res directly. Optional (self-modify off). */
  mcpHandler?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;
  /** How to resolve the caller's identity per request (provider-agnostic; may be
   *  store-enriched). Defaults to the env-configured resolver (header/alb-oidc). */
  resolveUser?: ResolveUser;
  /** In-pod web-service registry (list/start), powering the UI Services panel.
   *  Optional — absent in fake/local mode (no pods), where the routes report none. */
  webServices?: WebServiceRegistry;
  /** In-pod module registry (search/attach registry modules via scooter-rebuild),
   *  powering the Sandbox tab's module search/install + the settings module list.
   *  Optional — absent in fake/local mode. */
  moduleRegistry?: ModuleRegistry;
  /** The identity store (user_identity), for the email→Scooter-user reverse lookup
   *  that maps an invoking external (github/gitlab/slack) user to their internal
   *  user. Optional — absent = the lookup route reports no match. */
  identityStore?: IdentityStore;
  /** Image/media asset store (uploaded images). Powers GET
   *  /conversations/:id/assets/:assetId (replay). Optional — absent = images off. */
  assets?: AssetStore;
  /** Scheduler client (to the scheduler service), for the UI settings page's
   *  scheduled-tasks CRUD. The routes proxy to it scoped to the CALLER (x-auth-user
   *  = ctx.user.id), so a user only ever manages their own tasks. Optional — absent
   *  (no SCHEDULER_URL) = the routes report the scheduler isn't configured. */
  scheduler?: SchedulerClient;
  /** Manually compact a conversation (summarize older turns → continue on
   *  summary+recent). Wired in index.ts with the summarizer creds/model. Returns a
   *  result (or null if too short to compact); throws on summarizer failure — the
   *  route then leaves the conversation unchanged. Optional (absent = compaction off,
   *  e.g. fake/local mode or no OAuth token). */
  compact?: (conversationId: string) => Promise<{ summarizedTurns: number; keptRuns: number } | null>;
  /** The current sandbox resource request/limits (cpu/memory/gpu) for a conversation,
   *  so the Sandbox tab can show the user what the pod is allotted. Wired only on the
   *  broker path (the broker owns + applies sizing); absent = the route reports none. */
  sandboxResources?: (conversationId: string) => Promise<SandboxResources | undefined>;
  /** Bring-your-own-Claude (Increment 2): powers the Settings "Connect your Claude agent"
   *  section — mint an owner-bound join token + the copyable docker one-liner, and report whether
   *  the caller's agent is currently connected (for the live badge). Optional — absent when BYO
   *  isn't enabled (REMOTE_AGENT_JOIN_SECRET unset), so the UI hides the section. */
  remoteAgent?: {
    /** Mint a fresh short-lived join token for `owner` + the full `docker run …` one-liner. */
    /** Async: the session is minted on the CONTROLLER before the URL can be built (§L). */
    mint(owner: string): Promise<{ token: string; dockerCommand: string; wsUrl: string }>;
    /** Connected + the owner's most recent REJECTED connection attempt (for the Settings UI). */
    status(owner: string): Promise<{ connected: boolean; lastAuthFailure: { reason: string; at: string } | null }>;
    /** Is this owner's remote agent connected right now? Durable (DB, cross-replica) when a DB is
     *  wired, else the local live registry — hence async. */
    isConnected(owner: string): Promise<boolean>;
  };
}

/** The fields of a broker AWS request needed to render its approval interrupt.
 *  Matches the broker's request-view + the /aws-request POST body. */
export interface AwsRequestSummary {
  request_id: string;
  target_account?: string;
  risk_level?: string;
  policy_summary?: string;
  justification?: string;
}

/** Query the broker for a conversation's still-PENDING AWS requests (used by the revive re-raise).
 *
 *  CRITICAL id-space note: `brokerConversationId` MUST be the sandbox SHORT-id (the broker keys AWS
 *  requests by `sandbox-{shortId}`, extracted from the sandbox SA name), NOT the full thread UUID the
 *  session map uses. Passing the UUID returns an empty list — the bug where, after a rollout / resume /
 *  dangling-run revive, the pending Approve window never reappears. Callers resolve the short-id
 *  (via `shortId(threadId)`) before calling. Returns [] on any non-OK / error (best-effort). */
export async function fetchPendingAwsRequests(
  brokerUrl: string,
  brokerConversationId: string,
  authHeaders: Record<string, string>,
  onWarn?: (status: number) => void,
): Promise<AwsRequestSummary[]> {
  const base = brokerUrl.replace(/\/$/, "");
  if (!base) return [];
  const res = await fetch(
    `${base}/aws/aws/pending?conversation_id=${encodeURIComponent(brokerConversationId)}`,
    { method: "GET", headers: authHeaders },
  );
  if (!res.ok) {
    // 404/501 = no AWS broker configured; anything else is worth a log but not fatal.
    if (res.status !== 404 && res.status !== 501) onWarn?.(res.status);
    return [];
  }
  const body = (await res.json().catch(() => ({}))) as { requests?: AwsRequestSummary[] };
  return (body.requests ?? []).filter((r) => r.request_id);
}

/** Raise the Approve/Deny interrupt for a broker AWS request on a conversation's
 *  bridge, wiring the answer back to the broker via `resolveAwsRequest`. Shared by
 *  the /aws-request route (broker notifies at request time) AND the revive re-raise
 *  (index.ts onRevived, which rediscovers PENDING requests after a pod rollout
 *  dropped the in-memory interrupt). Keeping ONE builder means both paths produce an
 *  identical interrupt (same id/options/metadata/answer-routing). */
export function raiseAwsApprovalInterrupt(
  bridge: SessionBridge,
  conversationId: string,
  req: AwsRequestSummary,
  resolveAwsRequest?: ManagementDeps["resolveAwsRequest"],
): void {
  const summary =
    `Scooter is requesting AWS access to ${req.target_account} ` +
    `(risk: ${req.risk_level}).\n${req.policy_summary || ""}\n` +
    `Reason: ${req.justification || "(none)"}`;
  bridge.raiseInterrupt({
    id: req.request_id,
    message: summary,
    options: [
      { optionId: "approve", name: "Approve", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    // Tag it AWS so the UI runs a per-viewer can-approve check (greys the Approve
    // button for users who can't approve). requestId == the interrupt id, but carry
    // it explicitly so the UI needn't assume that.
    metadata: { aws: true, requestId: req.request_id },
    onAnswer: (optionId, approver) => {
      // The approver is the HUMAN who answered (from the permission route), not the
      // conversation owner — the broker authorizes the configured claim. Fall back
      // to the conversation id when there's no identity (anonymous / FGA-off / dev).
      const approverIdentity = approver ?? { id: conversationId };
      // resolveAwsRequest THROWS on a dropped approval (token unreadable / broker
      // 4xx-5xx); fire-and-forget, so handle the rejection — a swallowed one silently
      // loses the user's security decision.
      void resolveAwsRequest?.(conversationId, req.request_id, optionId === "approve", approverIdentity).catch(
        (err) => {
          log.errorWith("AWS approval NOT recorded", err, {
            conversation_id: conversationId,
            request_id: req.request_id,
            decision: optionId,
          });
        },
      );
    },
  });
}

export function createManagementApi(deps: ManagementDeps): Router {
  const { sessions, store, server } = deps;
  const models = deps.models ?? { available: [] };
  const r = createRouter(deps.resolveUser);

  // The agent-self-modify MCP endpoint (goose calls modify_environment here). The
  // MCP StreamableHTTP transport owns the response, so this handler reads the body
  // and hands req/res to it, then returns void (response already written).
  if (deps.mcpHandler) {
    const mcp = deps.mcpHandler;
    const mcpRoute = async (ctx: { req: IncomingMessage; res: ServerResponse; body: <T>() => Promise<T> }) => {
      const body = await ctx.body<unknown>().catch(() => undefined);
      await mcp(ctx.req, ctx.res, body);
    };
    r.post("/mcp", mcpRoute as never);
    r.get("/mcp", mcpRoute as never); // MCP also uses GET for the SSE stream
  }

  // Who the caller is, per the trusted ingress identity header (anonymous when
  // none). The UI uses this to label conversations as "mine" + show the user.
  r.get("/whoami", (ctx) => ({
    json: { id: ctx.user.id, email: ctx.user.email ?? null, anonymous: ctx.user.anonymous },
  }));

  // --- Bring-your-own-Claude: connect a personal Claude agent (Increment 2) ------------------
  // Owner-scoped: a caller manages ONLY their own agent (ctx.user.id). Absent deps.remoteAgent
  // (BYO not enabled) → 404 so the UI hides the section. Anonymous → 401 (an agent must bind to a
  // real user for routing + fencing).
  r.post("/remote-agent/join-token", async (ctx) => {
    if (!deps.remoteAgent) return { status: 404, json: { error: "remote agents not enabled" } };
    if (ctx.user.anonymous) return { status: 401, json: { error: "sign in to connect a Claude agent" } };
    // mint() round-trips the BYOC controller (POST /byoc/sessions). An unreachable controller
    // is an EXPECTED, diagnosable condition — the deployment is missing/unhealthy (the observed
    // case: the agent-pg-byoc Secret absent, so its pod never started) — not an internal error.
    // Without this catch the throw fell to the agui server's outer handler, which answers with
    // a RAW stringified error and no content-type: the Settings UI (expecting JSON) showed a
    // parser artifact, and "the controller is down" surfaced as an anonymous 500.
    try {
      const { token, dockerCommand, wsUrl } = await deps.remoteAgent.mint(ctx.user.id);
      // Return the raw token + the ready-to-copy one-liner (token baked in) + the wss URL.
      return { json: { token, dockerCommand, wsUrl } };
    } catch (err) {
      remoteAgentLog.errorWith("join-token mint failed", err, { user_id: ctx.user.id });
      // 503 (dependency unavailable), naming the dependency — and deliberately NOT echoing
      // err.message: this response gets logged/screenshotted, and an error path must never
      // carry token material or internals. The full error is in the host log above.
      return {
        status: 503,
        json: {
          error:
            "The BYOC controller is unreachable — the join token could not be issued. " +
            "Check that the byoc-controller Deployment is running (and its database secret exists), then retry.",
        },
      };
    }
  });

  r.get("/remote-agent/status", async (ctx) => {
    if (!deps.remoteAgent) return { status: 404, json: { error: "remote agents not enabled" } };
    if (ctx.user.anonymous) return { json: { connected: false, owner: null, lastAuthFailure: null } };
    // status() carries the owner's most recent REJECTED connection attempt alongside the
    // boolean — a failed container previously looked identical to one never started, on both
    // ends (the container fast-looped in silence; the UI showed a clean "disconnected").
    const st = await deps.remoteAgent.status(ctx.user.id);
    return { json: { connected: st.connected, owner: ctx.user.id, lastAuthFailure: st.lastAuthFailure } };
  });

  // Reverse identity lookup: the Scooter user id for an email. The webhooks service
  // uses this to map an invoking external (github/gitlab/slack) user — resolved to
  // an email via the provider API — to their internal user, so a webhook-spawned
  // conversation gets a real owner. Returns { id } on a match, 404 otherwise (no
  // directory dump — only a single id, and only for an exact email). No store /
  // no email -> 404.
  r.get("/users/by-email", async (ctx) => {
    const email = (ctx.query.get("email") ?? "").trim();
    if (!email) return { status: 400, json: { error: "email required" } };
    const match = deps.identityStore ? await deps.identityStore.getByEmail(email).catch(() => undefined) : undefined;
    if (!match) return { status: 404, json: { error: "no user with that email" } };
    return { json: { id: match.id } };
  });

  // The learned Scooter users, for the settings Users page. This is the set of users
  // who've actually signed in (or been mapped via a webhook) — a learned list, not a
  // full roster. Unlike /users/by-email (a single targeted lookup), this IS a
  // directory listing, but it's an authenticated internal tool (same trust model as
  // the conversation list, which is already public to authenticated callers). Gated
  // like the scheduler routes: 501 when no identity store is wired, so the UI can hide
  // the page. `configured` lets the client distinguish "off" from "on but empty".
  r.get("/users", async () => {
    if (!deps.identityStore) return { status: 501, json: { error: "identity store not configured" } };
    const users = await deps.identityStore.list().catch(() => []);
    return { json: { configured: true, users } };
  });

  // The model catalog — a UI populates its selector from this.
  r.get("/models", () => ({
    json: {
      default: models.default ?? null,
      available: models.available,
      hints: models.hints ?? {},
      // model id -> the provider tags offering it ([] = every provider). Lets the UI label
      // which choices apply to the BYO container vs the cloud floor.
      providers: models.providers ?? {},
    },
  }));

  // VIEW FILTER (not access control — conversations are public):
  //   ?scope=mine (default) -> conversations the caller owns + unowned/public ones.
  //   ?scope=all            -> everything.
  // An anonymous caller (no identity header) sees everything either way, so
  // single-user / local-dev is unchanged. Extracted so the list route AND the
  // /conversations/events push stream share ONE predicate — the stream is a
  // security boundary and must not leak more than the poll would.
  const visibleFilter = (ctx: { user: { anonymous: boolean; id: string }; query: URLSearchParams }) => {
    const scope = ctx.query.get("scope") ?? "mine";
    const user = ctx.user;
    // "all" and anonymous callers see everything (the latter is dev-friendly: no
    // ingress identity means we can't distinguish, so don't hide). For a KNOWN
    // user under "mine", show STRICTLY their own — an unowned conversation
    // (owner == null: legacy or a webhook that couldn't resolve a user) or another
    // user's is All-only, so Mine actually distinguishes instead of degrading to
    // All when many rows are unowned.
    return (c: { owner?: string }) =>
      scope === "all" || user.anonymous || c.owner === user.id;
  };

  // Enrich a conversation with its linked resources, so the sidebar can (a) show a
  // per-row provider icon, (b) display the linked PR/MR/thread NAME instead of the
  // title, and (c) filter by provider — all without a per-row /links fetch. Links are
  // file-backed (cheap; already loaded here). `sources` is the distinct provider set;
  // `links` is a COMPACT summary (source/type/title/url — no structured ref) for the
  // list. Shared by the list route and the push stream.
  const withSources = async (c: Conversation, now: number) => {
    const links = (await store.listLinks?.(c.id)) ?? [];
    const sources = [...new Set(links.map((l) => l.source))].sort();
    const linkSummary = links.map((l) => ({
      source: l.source,
      resourceType: l.resourceType,
      url: l.url,
      title: l.title,
    }));
    return { ...view(c, now), sources, links: linkSummary };
  };

  // CREATE a conversation. The SERVER mints the id — this route accepts no caller-chosen
  // threadId, which is the whole point: a client-chosen id would become an event-log key
  // and a k8s resource name.
  //
  // In MULTI-REPLICA the conversation-router serves this path instead (it writes the
  // Conversation CR without consulting host capacity) and never proxies it here. This
  // route is what SINGLE-REPLICA deployments — and e2e, which runs the agent-host with no
  // router in front — create through. Both mint server-side, so the UI has one contract.
  r.post("/conversations", async (ctx) => {
    const body = await ctx.body<{ title?: string; model?: string }>();
    // Reject an unknown model rather than silently falling back, so a client
    // mistake is visible.
    if (body.model && body.model !== models.default && !models.available.includes(body.model)) {
      return { status: 400, json: { error: `unknown model: ${body.model}` } };
    }
    // Stamp the creating user as the owner (for the "my conversations" filter).
    const owner = ctx.user.anonymous ? undefined : ctx.user.id;
    const conv = await sessions.start(randomUUID(), body.model, owner);
    if (body.title) sessions.setTitle(conv.id, body.title);
    return { status: 201, json: view(sessions.get(conv.id)!) };
  });

  r.get("/conversations", async (ctx) => {
    const now = Date.now();
    const list = sessions.list().filter(visibleFilter(ctx));
    const json = await Promise.all(list.map((c) => withSources(c, now)));
    return { json };
  });

  // GET /conversations/events — the conversation-LIST push stream. Emits an
  // initial { kind: "snapshot", conversations } (the visible list, same scope /
  // view-filter as GET /conversations), then { kind: "upsert", conversation } on
  // each SessionManager.onConversationChange (new conversation / title change),
  // filtered by the caller's scope so it never leaks more than the poll. Makes a
  // Slack thread appear in the sidebar instantly instead of on the 10s poll.
  r.get("/conversations/events", async (ctx) => {
    const { res } = ctx;
    // Bind the view-filter to THIS caller's scope+identity once — the same
    // predicate the REST list uses (a security boundary: the stream must not
    // emit conversations the poll would hide).
    const visible = visibleFilter(ctx);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (frame: unknown) => res.write(`data: ${JSON.stringify(frame)}\n\n`);

    // Initial snapshot: the visible list, each enriched with its link sources
    // (same shape as GET /conversations).
    const now = Date.now();
    const conversations = await Promise.all(
      sessions.list().filter(visible).map((c) => withSources(c, now)),
    );
    send({ kind: "snapshot", conversations });

    // Then push each lifecycle change (new conversation / title change) that
    // passes the filter as an upsert. Enrichment (sources) happens here, not in
    // the emitter, so the manager stays cheap. Emit the frame SYNCHRONOUSLY (a
    // base view with empty sources) so the change is on the wire immediately;
    // then, if the store has links, patch `sources` and re-emit. A brand-new
    // conversation almost never has links yet, so the first frame is usually the
    // only one — but the two-phase emit means a webhook-linked conversation still
    // gets its provider icon without waiting on the next poll/snapshot.
    const unsub = sessions.onConversationChange((c) => {
      if (!visible(c)) return;
      const now = Date.now();
      send({ kind: "upsert", conversation: { ...view(c, now), sources: [] as string[] } });
      void withSources(c, now).then((conversation) => {
        if (conversation.sources.length) send({ kind: "upsert", conversation });
      });
    });

    ctx.req.on("close", () => unsub());
  });

  // No POST /conversations here: creating a conversation is a control-plane write
  // served by the conversation-router (services/conversation-router/create.go).
  // This fleet is capacity-bounded, so creating here gated the id on capacity.

  r.get("/conversations/:id", async (ctx) => {
    // Hydrate-if-absent (read-only) so a reconnect after a pod move / cleared CR resolves
    // instead of 404ing. See events.integrity + ROLLOUT_DRAIN_AND_POD_IP.md.
    let conv = sessions.get(ctx.params.id);
    if (!conv && (await sessions.ensureReadable(ctx.params.id))) conv = sessions.get(ctx.params.id);
    return conv ? { json: view(conv) } : { status: 404, json: { error: "not found" } };
  });

  r.del("/conversations/:id", async (ctx) => {
    // Hydrate-if-absent so a DELETE routed to a pod that doesn't hold the conversation in
    // memory still destroys it, instead of 404ing and leaking the sandbox (multi-replica:
    // the DELETE-404 leak — same class as the read-path 404). Mirrors the GET route.
    let conv = sessions.get(ctx.params.id);
    if (!conv && (await sessions.ensureReadable(ctx.params.id))) conv = sessions.get(ctx.params.id);
    if (!conv) return { status: 404, json: { error: "not found" } };
    // STARRED = protected from deletion (accidental-delete guard). A star means "keep this";
    // the caller must unstar first. 409 Conflict (the resource state forbids the delete).
    if (conv.starred) return { status: 409, json: { error: "conversation is starred; unstar before deleting" } };
    await sessions.end(ctx.params.id);
    return { status: 204, json: null };
  });

  // Only the OWNER (or an anonymous / single-user caller, or an unowned conversation)
  // may rename/star — same inclusion rule as the "mine" view filter. Returns the
  // conversation if the caller may mutate it, else a 404 (don't reveal ownership) or
  // 403. Conversations are otherwise public to READ; these are the write boundary.
  const mutableFor = (id: string, user: { anonymous: boolean; id: string }) => {
    const conv = sessions.get(id);
    if (!conv) return { conv: undefined as Conversation | undefined, error: 404 as const };
    // An identified user may mutate their own or an unowned conversation; not someone
    // else's. Anonymous (no ingress identity) is single-user mode — may mutate any.
    if (!user.anonymous && conv.owner && conv.owner !== user.id) {
      return { conv: undefined, error: 403 as const };
    }
    return { conv, error: undefined };
  };

  // User rename: sets the title AND locks it (userTitled) so the agent's <title> can
  // no longer overwrite it. A blank/whitespace title is rejected (would orphan the row).
  r.patch("/conversations/:id/title", async (ctx) => {
    const { conv, error } = mutableFor(ctx.params.id, ctx.user);
    if (error === 404) return { status: 404, json: { error: "not found" } };
    if (error === 403) return { status: 403, json: { error: "not your conversation" } };
    const body = await ctx.body<{ title?: string }>();
    const title = (body.title ?? "").trim();
    if (!title) return { status: 400, json: { error: "title is required" } };
    if (title.length > 200) return { status: 400, json: { error: "title too long (max 200)" } };
    await sessions.setUserTitle(conv!.id, title);
    return { json: view(sessions.get(conv!.id)!) };
  });

  // Star / unstar. Body { starred: boolean }.
  r.patch("/conversations/:id/starred", async (ctx) => {
    const { conv, error } = mutableFor(ctx.params.id, ctx.user);
    if (error === 404) return { status: 404, json: { error: "not found" } };
    if (error === 403) return { status: 403, json: { error: "not your conversation" } };
    const body = await ctx.body<{ starred?: boolean }>();
    if (typeof body.starred !== "boolean") {
      return { status: 400, json: { error: "starred (boolean) is required" } };
    }
    await sessions.setStarred(conv!.id, body.starred);
    return { json: view(sessions.get(conv!.id)!) };
  });

  r.post("/conversations/:id/suspend", async (ctx) => {
    // Hydrate-if-absent so suspend reaches the conversation regardless of which replica
    // answers (same multi-replica 404 class as DELETE/read).
    if (!sessions.get(ctx.params.id) && (await sessions.ensureReadable(ctx.params.id))) {
      /* hydrated into memory */
    }
    if (!sessions.get(ctx.params.id)) return { status: 404, json: { error: "not found" } };
    await sessions.suspend(ctx.params.id);
    return { json: view(sessions.get(ctx.params.id)!) };
  });

  r.post("/conversations/:id/resume", async (ctx) => {
    if (!sessions.get(ctx.params.id)) return { status: 404, json: { error: "not found" } };
    await sessions.revive(ctx.params.id);
    return { json: view(sessions.get(ctx.params.id)!) };
  });

  // Cluster-internal REVIVE-ON-ASSIGN (seamless rollout). The controller POSTs this on a
  // conversation's new host right after (re)assigning it, so the host replays history from
  // the shared mirror BEFORE user traffic arrives. Unlike /resume above, this MUST work when
  // the conversation is NOT already in memory (that's the whole point — it was just
  // reassigned here from a drained pod). Idempotent: a no-op if already revived. Fencing:
  // the `gen` query param is the CR's current generation; if this pod isn't the current
  // owner (or the push is stale), skip — the ownership guard still gates writes regardless.
  //
  // DESIGN STUB — not implemented. Must: (1) verify caller is the controller (SA/secret —
  // spec Q4); (2) hydrate-from-mirror if absent; (3) fence on `gen`; (4) be safe to call
  // concurrently / repeatedly. See todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md.
  r.post("/internal/revive/:id", async (ctx) => {
    const gen = Number(new URL(ctx.req.url ?? "", "http://x").searchParams.get("gen") ?? "0");
    // Hydrate-if-absent + fence (a stale/mis-routed push is a no-op inside reviveFromMirror).
    // Best-effort from the controller's view; return 202 (accepted) rather than 200 so a
    // caller can tell it's an async pre-warm, not a synchronous "definitely revived".
    await sessions.reviveFromMirror(ctx.params.id, Number.isFinite(gen) ? gen : 0);
    return { status: 202, json: { revived: ctx.params.id } };
  });

  // Manually COMPACT: summarize older turns, then continue on [summary + recent].
  // Summarize + persist the marker FIRST (compact() throws on summarizer failure →
  // 502, conversation untouched); only on success do we revive so the next turn runs
  // on the compacted context.
  r.post("/conversations/:id/compact", async (ctx) => {
    const conv = sessions.get(ctx.params.id);
    if (!conv) return { status: 404, json: { error: "not found" } };
    if (!deps.compact) return { status: 501, json: { error: "compaction unavailable" } };
    let result: { summarizedTurns: number; keptRuns: number } | null;
    try {
      result = await deps.compact(conv.id);
    } catch (e) {
      return { status: 502, json: { error: `compaction failed: ${(e as Error).message}` } };
    }
    if (!result) return { status: 200, json: { ok: true, compacted: false, reason: "conversation too short to compact" } };
    // Revive so the fresh session resumes from the compacted history (loadHistory).
    await sessions.revive(conv.id);
    return { status: 202, json: { ok: true, compacted: true, ...result } };
  });

  r.post("/conversations/:id/messages", async (ctx) => {
    const body = await ctx.body<{ text?: string }>();
    if (!body.text) return { status: 400, json: { error: "text required" } };
    // find-or-start by thread id, then prompt
    await sessions.promptByThread(ctx.params.id, body.text);
    return { status: 202, json: { ok: true } };
  });

  // Stop the RUNNING turn — the UI's Stop button. cancel() ends the in-flight run
  // cleanly (kills the active tool call via the exec seam, ACP session/cancel, and
  // emits a RUN_FINISHED{cancelled:true}). No-op-OK: a conversation with no live
  // bridge or nothing running still returns 202 (stopping "nothing" succeeded), so
  // a stale Stop click never errors. 404 only for a genuinely unknown conversation.
  r.post("/conversations/:id/cancel", async (ctx) => {
    const conv = sessions.get(ctx.params.id);
    if (!conv) return { status: 404, json: { error: "not found" } };
    // `bridge?.cancel()` answers 202 even with NO bridge — a silent no-op indistinguishable
    // from a real stop. Record which happened.
    log.info("cancel requested", {
      conversation_id: ctx.params.id,
      has_bridge: conv.bridge !== undefined,
      status: conv.status,
    });
    await conv.bridge?.cancel(undefined, true);
    return { status: 202, json: { ok: true } };
  });

  r.get("/conversations/:id/history", async (ctx) => {
    // Return events + the rolling integrity checksum through the last one, so a
    // streaming client can verify it has replayed the complete, in-order log
    // (and reconcile against live events' prevChecksum). Falls back gracefully
    // for stores without the checksum variant (in-memory test stores).
    const events: AguiEvent[] = [];
    let checksum = EMPTY_CHECKSUM;
    if (store.readEventsWithChecksum) {
      for await (const c of store.readEventsWithChecksum(ctx.params.id)) {
        events.push(c.event);
        checksum = c.checksum;
      }
    } else {
      for await (const e of store.readEvents(ctx.params.id)) events.push(e);
      checksum = chainAll(events);
    }
    return { json: { events, checksum } };
  });

  // Stream an uploaded image back (replay + the thread's own view). Conversation-
  // scoped: the assetId is only readable under its own conversation id (the store
  // isolates per conversation + guards path traversal), so an id can't leak an
  // asset from another conversation. Returns the raw bytes with the right
  // content-type; the handler writes the response itself (binary, not JSON).
  r.get("/conversations/:id/assets/:assetId", async (ctx) => {
    const res = ctx.res;
    if (!deps.assets) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"assets not enabled"}');
      return;
    }
    const asset = await deps.assets.read(ctx.params.id, ctx.params.assetId);
    if (!asset) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"unknown asset"}');
      return;
    }
    res.writeHead(200, {
      "Content-Type": asset.mimeType,
      "Content-Length": String(asset.data.length),
      // Immutable: the assetId is content-addressed, so the bytes never change.
      "Cache-Control": "private, max-age=31536000, immutable",
    });
    res.end(asset.data);
  });

  r.get("/conversations/:id/tail", async (ctx) => {
    // A fast first-paint window: the events from the last N runs (default 8), so a
    // client opening a LONG conversation can render the latest context instantly
    // instead of waiting for the whole log to stream + fold. Windowed on RUN
    // boundaries so every message/tool call in the tail is complete and folds
    // identically to a full replay — the client then reconciles against the full
    // integrity stream with no visible change. NOT checksummed (a partial window).
    const runsParam = Number(ctx.query.get("runs"));
    const runs = Number.isFinite(runsParam) && runsParam > 0 ? Math.min(runsParam, 100) : 8;
    // Fast path: read ONLY the tail (scan from the end, parse the window). Falls
    // back to reading + windowing the whole log for stores without the tail reader
    // (in-memory test stores) — those logs are tiny so the cost is irrelevant.
    let events: AguiEvent[];
    if (store.readEventsTail) {
      events = await store.readEventsTail(ctx.params.id, runs);
    } else {
      const all: AguiEvent[] = [];
      for await (const e of store.readEvents(ctx.params.id)) all.push(e);
      events = tailByRuns(all, runs);
    }
    return { json: { events, runs } };
  });

  r.get("/conversations/:id/events", async (ctx) => {
    // Ensure history is local first (a reconnect may land on a non-owner pod after a
    // rollout / cleared CR) so onAttach's store.readEvents replays the full log. Read-only.
    if (!sessions.get(ctx.params.id)) await sessions.ensureReadable(ctx.params.id);
    // SSE — the server owns the connection; returns void (no JSON result).
    await server.subscribeSSE(ctx.params.id, ctx.res);
  });

  // Integrity stream: replay the full log (each event + its rolling checksum),
  // then stay open and forward live appends with their checksums. Plain JSON SSE
  // (NOT the @ag-ui encoder — this carries our integrity envelope, which the
  // @ag-ui client would reject). The UI uses this to render reliably AND to
  // self-heal: if a live event's prevChecksum != the checksum it holds, it has a
  // gap and refetches history. Single ordered stream → no replay-vs-live race.
  r.get("/conversations/:id/events.integrity", async (ctx) => {
    const id = ctx.params.id;
    const { res } = ctx;
    // Make history readable on THIS pod first: after a rollout (or a cleared CR) the owner
    // pod may have moved, so a reconnecting UI lands on a pod that doesn't have the
    // conversation in memory. ensureReadable pulls it from the mirror (read-only, no sandbox
    // spin-up). Only 404 if it's genuinely unknown ANYWHERE — so the client stops
    // reconnecting for a truly deleted conversation, but a moved one self-heals.
    if (!sessions.get(id) && !(await sessions.ensureReadable(id))) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (frame: unknown) => res.write(`data: ${JSON.stringify(frame)}\n\n`);

    // Subscribe to live appends FIRST so nothing emitted during replay is lost;
    // buffer them until replay is done, then flush + go live. Dedup by checksum
    // (an event seen in replay won't be re-sent live).
    const seen = new Set<string>();
    let live = false;
    const buffer: ChecksummedEvent[] = [];
    const unsub = store.onAppend?.((evId, c) => {
      if (evId !== id) return;
      if (!live) buffer.push(c);
      else if (!seen.has(c.checksum)) {
        seen.add(c.checksum);
        send({ kind: "event", ...c });
      }
    });

    // FLUSH pending appends before replaying: appends are fire-and-forget (void
    // store.appendEvent), so a fresh revive's just-sent user message can still be mid-write when
    // the UI opens this stream. readEventsWithChecksum would then read a log WITHOUT it, and its
    // onAppend fires only AFTER the write lands — so it's in neither the replay nor the pre-live
    // buffer, and the message "disappears" until the user refreshes. Awaiting flush(id) makes
    // every enqueued append durable (and its onAppend fired → buffered) before we read. (No-op
    // for synchronous in-memory stores.)
    await store.flush?.(id);

    // Replay persisted history with checksums, from the DURABLE store. Reading the
    // local-only log here replayed NOTHING on a pod whose emptyDir was wiped by a restart:
    // the conversation is in memory (hydrate loads meta from the mirror) so this route's
    // guard passes, but its events were never pulled, and the stream honestly reported
    // `synced` with zero events. Observed live: every one of 123 conversations after a
    // rollout, each with a full mirrored log. PR #405.
    // NB: call through `store` — these are object methods that use `this` internally, so a
    // detached reference (`const replay = store.x`) loses the binding at runtime.
    const replay = store.readEventsDurableWithChecksum
      ? (i: SessionId) => store.readEventsDurableWithChecksum!(i)
      : store.readEventsWithChecksum
        ? (i: SessionId) => store.readEventsWithChecksum!(i)
        : undefined;
    if (replay) {
      for await (const c of replay(id)) {
        seen.add(c.checksum);
        send({ kind: "event", ...c });
      }
    }
    // Flush anything that arrived during replay, then go live.
    for (const c of buffer) {
      if (!seen.has(c.checksum)) {
        seen.add(c.checksum);
        send({ kind: "event", ...c });
      }
    }
    live = true;
    // Mark the end of the initial replay so the client knows it's caught up.
    send({ kind: "synced" });

      // OWNERSHIP: this stream only carries LIVE events for a conversation THIS pod
      // runs (onAppend is the local store). If another pod owns it — typical when the
      // stream was opened BEFORE the controller assigned an owner, and the router
      // therefore picked a pod at random — end the stream after the replay: the
      // client's reconnect goes back through the router, which routes by hostIP now.
      // Checked again periodically so a MID-STREAM reassignment also hands the viewer
      // to the new owner instead of leaving them on a silent stream.
      const closeIfElsewhere = async () => {
        const where = await deps.streamOwnership?.(id).catch(() => "unknown" as const);
        if (where === "elsewhere") {
          try { res.write(": owner-elsewhere — reconnect\n\n"); } catch { /* closing */ }
          res.end();
        }
      };
      void closeIfElsewhere();
      const ownershipTimer = setInterval(() => void closeIfElsewhere(), 5_000);
      if (typeof ownershipTimer.unref === "function") ownershipTimer.unref();

    // SSE HEARTBEAT: an idle conversation emits no events, so without this the stream
    // goes byte-silent until the next activity. Any proxy in front (the UI's nginx has
    // proxy_read_timeout 3600s; an ingress/LB may be far stricter) then times the
    // upstream out — the observed `upstream timed out (110) ... events.integrity`,
    // dropping a live viewer's stream on a quiet conversation. Send an SSE COMMENT line
    // (`:`-prefixed) every 25s: it keeps the connection warm for every proxy layer, and
    // the client parser ignores it (it only reads `data:` lines). Cleared on close.
    const heartbeat = setInterval(() => {
      // res.write can throw if the socket is already gone between 'close' and clear.
      try { res.write(": ping\n\n"); } catch { /* connection closed — the close handler clears this */ }
    }, 25_000);
    // Don't let the heartbeat timer keep the process alive on shutdown.
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    ctx.req.on("close", () => {
      clearInterval(heartbeat);
      clearInterval(ownershipTimer);
      unsub?.();
    });
  });

  r.post("/conversations/:id/permission/:toolCallId", async (ctx) => {
    const body = await ctx.body<{ optionId?: string }>();
    if (!body.optionId) return { status: 400, json: { error: "optionId required" } };
    // The answering user's identity — the broker authorizes THIS person for an AWS
    // approval (not the conversation owner). Anonymous → no identity claims.
    const approver = ctx.user.anonymous
      ? undefined
      : { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name };
    await deps.answerPermission(ctx.params.id, ctx.params.toolCallId, body.optionId, approver);
    return { status: 204, json: null };
  });

  // May the CURRENT viewer approve this AWS request? The UI calls this per pending
  // AWS interrupt to decide whether to grey out the Approve button (per-viewer: the
  // interrupt is raised once server-side but seen by many users). Anonymous users
  // can never approve (no identity to authorize) → canApprove:false, greyed button.
  r.get("/conversations/:id/aws-request/:requestId/can-approve", async (ctx) => {
    if (!deps.canApproveAwsRequest) return { json: { canApprove: true } }; // unwired → don't block
    if (ctx.user.anonymous) return { json: { canApprove: false } };
    const approver = { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name };
    const canApprove = await deps
      .canApproveAwsRequest(ctx.params.id, ctx.params.requestId, approver)
      .catch(() => false); // fail closed (greyed) on any error
    return { json: { canApprove } };
  });

  // External resource links (the GitHub PR / Slack thread a conversation came
  // from). The webhooks service POSTs them on create; the UI GETs them for the
  // linked-resources panel.
  // Resolve a conversation id that MIGHT be the broker's short DNS hash
  // (`sandbox-{shortId}`) rather than the full threadId the store keys by. The
  // broker (auto-link injector + explicit /link) identifies the conversation
  // from the SA token, which carries the short id — a plain store.*(ctx.params.id)
  // would miss it (the same shortId mismatch that broke aws-request). Falls back
  // to the raw id for UI/webhooks callers that already pass the full threadId.
  const resolveConvId = async (id: string): Promise<string | null> => {
    const conv = sessions.get(id) ?? (await sessions.getByShortId(id));
    return conv?.id ?? null;
  };

  r.get("/conversations/:id/links", async (ctx) => {
    const id = (await resolveConvId(ctx.params.id)) ?? ctx.params.id;
    const links = (await store.listLinks?.(id)) ?? [];
    return { json: { links } };
  });

  r.post("/conversations/:id/links", async (ctx) => {
    const body = await ctx.body<{
      source?: string;
      resourceType?: string;
      url?: string;
      title?: string;
      ref?: ConversationLink["ref"];
    }>();
    if (!body.source || !body.resourceType) {
      return { status: 400, json: { error: "source and resourceType required" } };
    }
    // Fall back to the raw path id when resolution misses — a link may be
    // registered BEFORE the conversation materializes: the Slack webhook flow
    // posts the thread link in its on_created hook (to anchor the first reply to
    // the thread) which fires before /agui creates the session. 404-ing here
    // silently dropped that link (the broker-autolink regression). The store keys
    // by the full threadId, which is exactly what the webhook posts, so writing
    // under the raw id makes it resolvable once the conversation exists (GET does
    // the same fallback).
    const id = (await resolveConvId(ctx.params.id)) ?? ctx.params.id;
    await store.addLink?.(id, {
      source: body.source,
      resourceType: body.resourceType,
      url: body.url,
      title: body.title,
      ref: body.ref,
    });
    return { status: 201, json: { ok: true } };
  });

  // Web services (marimo/xterm/vscode) declared in the conversation's sandbox and
  // reverse-proxied at /c/<id>/<name>/. The UI Services panel lists them (with
  // liveness) and Starts one. No extra auth — same view-filter model as the rest.
  // Actual pod readiness — the conversation `status` can be "running" (Sandbox
  // operatingMode Running) while the pod is still ContainerCreating. exec succeeds
  // only once the pod is Ready, so this distinguishes "requested" from "actually up".
  // The UI Sandbox tab shows "Starting…" while status=running but ready=false.
  r.get("/conversations/:id/ready", async (ctx) => {
    const id = await resolveConvId(ctx.params.id);
    const conv = id ? sessions.get(id) : undefined;
    // Only a running-status conversation can be ready; suspended/ended are never ready.
    if (!id || !conv || conv.status !== "running" || !deps.webServices) {
      return { json: { ready: false, status: conv?.status ?? "unknown" } };
    }
    const ready = await deps.webServices.ready(id).catch(() => false);
    return { json: { ready, status: conv.status } };
  });

  r.get("/conversations/:id/web-services", async (ctx) => {
    const id = await resolveConvId(ctx.params.id);
    if (!id || !deps.webServices) return { json: { services: [] } };
    const services = await deps.webServices.list(id);
    const withState = await Promise.all(
      services.map(async (s) => ({
        name: s.name,
        displayName: s.displayName,
        // The browser opens the service under the FULL threadId path.
        url: `/c/${encodeURIComponent(sessions.get(id)?.threadId ?? id)}/${s.name}/`,
        running: await deps.webServices!.isRunning(id, s.name).catch(() => false),
      })),
    );
    return { json: { services: withState } };
  });

  // The sandbox's current resource allotment (cpu/memory/gpu requests + limits), so
  // the Sandbox tab can show the user what the pod is sized for. Absent getter (no
  // broker / fake mode) -> {resources: null}, and the UI simply doesn't show the row.
  r.get("/conversations/:id/resources", async (ctx) => {
    const id = await resolveConvId(ctx.params.id);
    if (!id || !deps.sandboxResources) return { json: { resources: null } };
    const resources = (await deps.sandboxResources(id).catch(() => undefined)) ?? null;
    return { json: { resources } };
  });

  r.post("/conversations/:id/web-services/:name/start", async (ctx) => {
    const id = await resolveConvId(ctx.params.id);
    if (!id) return { status: 404, json: { error: "unknown conversation" } };
    if (!deps.webServices) return { status: 501, json: { error: "web services unavailable" } };
    const svc = await deps.webServices.get(id, ctx.params.name);
    if (!svc) return { status: 404, json: { error: "unknown web service" } };
    try {
      await deps.webServices.start(id, ctx.params.name);
    } catch (e) {
      return { status: 502, json: { error: `start failed: ${(e as Error).message}` } };
    }
    return { status: 202, json: { ok: true } };
  });

  r.post("/conversations/:id/web-services/:name/stop", async (ctx) => {
    const id = await resolveConvId(ctx.params.id);
    if (!id) return { status: 404, json: { error: "unknown conversation" } };
    if (!deps.webServices) return { status: 501, json: { error: "web services unavailable" } };
    const svc = await deps.webServices.get(id, ctx.params.name);
    if (!svc) return { status: 404, json: { error: "unknown web service" } };
    try {
      await deps.webServices.stop(id, ctx.params.name);
    } catch (e) {
      return { status: 502, json: { error: `stop failed: ${(e as Error).message}` } };
    }
    return { status: 202, json: { ok: true } };
  });

  // --- Modules (Sandbox tab search/install + settings list) --------------------
  // `configured` distinguishes "no module registry wired" (fake/local) from
  // "configured but nothing found", so the UI shows the right empty state.
  const noModules = { status: 501, json: { configured: false, error: "modules unavailable" } };

  // Search the broker module catalog (caller's own + all public). Empty q = all.
  // Also used by the settings "available modules" list. Includes which are attached.
  r.get("/conversations/:id/module-registry", async (ctx) => {
    if (!deps.moduleRegistry) return noModules;
    const id = await resolveConvId(ctx.params.id);
    if (!id) return { status: 404, json: { error: "unknown conversation" } };
    const q = ctx.query.get("q") ?? "";
    const [modules, attached] = await Promise.all([
      deps.moduleRegistry.search(id, q),
      deps.moduleRegistry.attached(id).catch(() => [] as string[]),
    ]);
    const attachedSet = new Set(attached);
    return {
      json: {
        configured: true,
        modules: modules.map((m) => ({ ...m, attached: attachedSet.has(m.name) })),
      },
    };
  });

  // The registry modules currently attached to this conversation (names).
  r.get("/conversations/:id/modules", async (ctx) => {
    if (!deps.moduleRegistry) return noModules;
    const id = await resolveConvId(ctx.params.id);
    if (!id) return { status: 404, json: { error: "unknown conversation" } };
    return { json: { configured: true, attached: await deps.moduleRegistry.attached(id) } };
  });

  // Install (attach) a registry module by name-or-id + re-converge. Needs the pod
  // running (the CLI runs in-pod).
  r.post("/conversations/:id/modules/:ref/install", async (ctx) => {
    if (!deps.moduleRegistry) return noModules;
    const id = await resolveConvId(ctx.params.id);
    if (!id) return { status: 404, json: { error: "unknown conversation" } };
    try {
      const message = await deps.moduleRegistry.install(id, ctx.params.ref);
      return { status: 202, json: { ok: true, message } };
    } catch (e) {
      return { status: 502, json: { error: `install failed: ${(e as Error).message}` } };
    }
  });

  // The broker calls this when an agent requests AWS access: raise an in-
  // conversation approval interrupt (Approve / Deny). The user's pick routes back
  // to the broker (approve/deny) via deps.resolveAwsRequest.
  r.post("/conversations/:id/aws-request", async (ctx) => {
    const body = await ctx.body<{
      request_id?: string;
      target_account?: string;
      risk_level?: string;
      policy_summary?: string;
      justification?: string;
    }>();
    if (!body.request_id) return { status: 400, json: { error: "request_id required" } };
    // Resolve the conversation. The BROKER identifies it by the SHORT DNS-safe
    // hash (from the sandbox SA name `sandbox-{shortId}`), NOT the full threadId
    // the session map is keyed by — so a plain get(ctx.params.id) MISSES and the
    // approval 404s (the "window never appears" root cause). Try the full id first
    // (webhooks/UI use it), then fall back to the short-id resolution (which also
    // hydrates a persisted-but-evicted conversation).
    const conv =
      sessions.get(ctx.params.id) ?? (await sessions.getByShortId(ctx.params.id));
    if (!conv) {
      // A genuinely unknown conversation — nothing to raise the interrupt on.
      return { status: 404, json: { error: "unknown conversation" } };
    }
    // The conversation exists but its in-memory BRIDGE may be absent — it was
    // idle-suspended, or hydrated-but-not-revived after an agent-host restart, or
    // torn down by a model switch. The agent that called `scooter-aws request` is
    // still running in the sandbox, so we MUST NOT drop the approval on the floor:
    // revive to rebuild the bridge, then raise. Without this the route dropped it
    // and the broker (fire-and-forget) swallowed it — "the approval window never
    // appeared." raiseInterrupt persists the interrupt, so it also survives a
    // reload once raised. Key off the RESOLVED conversation's real id (conv.id),
    // not ctx.params.id, which may be the short hash.
    let bridge = sessions.get(conv.id)?.bridge;
    if (!bridge) {
      try {
        await sessions.revive(conv.id);
        bridge = sessions.get(conv.id)?.bridge;
      } catch (err) {
        log.errorWith("aws-request could not revive", err, { conversation_id: conv.id });
      }
    }
    if (!bridge) return { status: 503, json: { error: "could not activate conversation to raise the approval" } };

    raiseAwsApprovalInterrupt(bridge, conv.id, body as AwsRequestSummary, deps.resolveAwsRequest);
    return { status: 202, json: { ok: true } };
  });

  // --- Scheduled tasks (UI settings page) ----------------------------------------
  // Proxy CRUD to the scheduler service, SCOPED to the caller: every call passes
  // x-auth-user = the caller's id (or null → the unowned/anonymous bucket, which is
  // a valid scope, not a refusal — same as the agent MCP tools). Absent scheduler
  // (no SCHEDULER_URL) → 501.
  const scheduler = deps.scheduler;
  const scopeOwner = (ctx: { user: { anonymous: boolean; id: string } }) =>
    ctx.user.anonymous ? null : ctx.user.id;
  const noScheduler = { status: 501, json: { error: "scheduler not configured" } };

  r.get("/scheduled-tasks", async (ctx) => {
    if (!scheduler) return noScheduler;
    return { json: { tasks: await scheduler.list(scopeOwner(ctx)) } };
  });

  r.post("/scheduled-tasks", async (ctx) => {
    if (!scheduler) return noScheduler;
    const body = await ctx.body<{ title?: string; prompt?: string; cron?: string; timezone?: string; enabled?: boolean }>();
    if (!body.title || !body.prompt || !body.cron) {
      return { status: 400, json: { error: "title, prompt, and cron are required" } };
    }
    try {
      const task = await scheduler.create(scopeOwner(ctx), {
        title: body.title, prompt: body.prompt, cron: body.cron, timezone: body.timezone, enabled: body.enabled,
      });
      return { status: 201, json: task };
    } catch (e) {
      return { status: 400, json: { error: (e as Error)?.message ?? "create failed" } };
    }
  });

  r.get("/scheduled-tasks/:id", async (ctx) => {
    if (!scheduler) return noScheduler;
    const owner = scopeOwner(ctx);
    const task = await scheduler.get(owner, ctx.params.id);
    if (!task) return { status: 404, json: { error: "not found" } };
    const runs = await scheduler.runs(owner, ctx.params.id).catch(() => []);
    return { json: { task, runs } };
  });

  r.patch("/scheduled-tasks/:id", async (ctx) => {
    if (!scheduler) return noScheduler;
    const body = await ctx.body<Partial<{ title: string; prompt: string; cron: string; timezone: string; enabled: boolean }>>();
    try {
      const task = await scheduler.patch(scopeOwner(ctx), ctx.params.id, body);
      if (!task) return { status: 404, json: { error: "not found" } };
      return { json: task };
    } catch (e) {
      return { status: 400, json: { error: (e as Error)?.message ?? "update failed" } };
    }
  });

  r.del("/scheduled-tasks/:id", async (ctx) => {
    if (!scheduler) return noScheduler;
    const gone = await scheduler.del(scopeOwner(ctx), ctx.params.id);
    return gone ? { status: 204, json: null } : { status: 404, json: { error: "not found" } };
  });

  return r;
}
