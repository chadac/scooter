/**
 * Management API: the REST surface around the SessionManager (conversation CRUD,
 * lifecycle, history, approvals, sandbox services). The AG-UI streaming endpoint
 * (POST /agui) stays the assistant-ui transport; these routes sit next to it on
 * the same node:http server.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createRouter, type JsonResult, type Router, type ResolveUser } from "../http/router.js";
import type { SessionManager, Conversation } from "../session/manager.js";
import type { ConversationStore, ChecksummedEvent, ConversationLink } from "../session/manager.js";
import { shortId } from "../session/manager.js";
import type { SessionId } from "../types.js";
import { tailByRuns } from "../session/eventWindow.js";
import { trimToBoundary } from "../session/eventStore.js";
import {
  alignPageToRun,
  foldToMessages,
  MESSAGE_EVENTS,
  splitForInitialSnapshot,
} from "../agent/messagesSnapshot.js";

import type { AguiServer } from "../agui/server.js";
import type { WebServiceRegistry } from "../proxy/webServiceProxy.js";
import type { IdentityStore } from "../auth/identityStore.js";
import type { AssetStore } from "../session/assetStore.js";
import { targetError, type ConversationOwnerLookup, type SchedulerClient } from "../agent/schedulerTools.js";
import { mountContribApi, type ContribApiDeps } from "./contribApi.js";
import { UserSkillError, type UserSkill, type UserSkillStore } from "../session/userSkillStore.js";
import type { SandboxResources } from "../session/resources.js";
import { fitAdvice, fitSummary } from "../session/resourceFit.js";
import type { SandboxSizePreset } from "../session/resources.js";
import { PRIORITY_INTERRUPT, type AguiEvent, type ApproverIdentity, type SessionBridge } from "../bridge.js";
import { logger } from "../log.js";
import type { AccessCheck } from "../session/access.js";
import { isVisibility } from "../session/visibility.js";
import { serviceUrl, type SandboxOrigins } from "../proxy/sandboxOrigin.js";
import { EMPTY_CHECKSUM, chainAll } from "../agui/integrity.js";
import { DERIVED_SOURCES, HUMAN_TRIGGER_SOURCES } from "../acp/remoteAgentRegistry.js";
import type { HookDef } from "../hooks/types.js";
import type { UserHookSettingsStore } from "../hooks/userHookSettingsStore.js";

const log = logger("agent-host");
const remoteAgentLog = logger("remote-agent");

/** Sources POST /messages refuses, so a sandbox cannot pose as human. */
const RESERVED_SOURCES: ReadonlySet<string> = new Set([...HUMAN_TRIGGER_SOURCES, ...DERIVED_SOURCES]);

/** Set by the router's sandbox self-access listener. */
const SANDBOX_CALLER_HEADER = "x-scooter-caller";
/** The source given to a sandbox's message that names none. */
export const SANDBOX_SOURCE = "sandbox";

/** Whether a POST /messages caller may tag its message with this system source. */
export function isPostableSource(source: unknown): source is string {
  return typeof source === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(source) && !RESERVED_SOURCES.has(source);
}

/** Public JSON-safe view of a conversation (omits the in-memory bridge). */
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
    // The spawning conversation when this is a subagent; undefined means top-level.
    parentId: c.parentId,
    // Set by a user rename; the agent's <title> does not override it.
    userTitled: c.userTitled ?? false,
    starred: c.starred ?? false,
    visibility: c.visibility ?? "shared",
    sandbox: { name: c.sandbox.name, namespace: c.sandbox.namespace },
  };
}

export interface ManagementDeps {
  sessions: SessionManager;
  store: ConversationStore;
  /** Which pod serves this conversation's live stream; absent means single-replica, where everything is "mine". */
  streamOwnership?: (id: string) => Promise<"mine" | "elsewhere" | "unknown">;
  server: AguiServer;
  /** Answer a pending tool permission as `approver`, the identity of the human answering. */
  answerPermission: (sessionId: string, toolCallId: string, optionId: string, approver?: ApproverIdentity) => Promise<void>;
  /** Relay the user's answer (the optionId is the verb) to the contrib's broker half as `approver`; throws on a dropped answer. */
  resolveApproval?: (
    sessionId: string,
    contrib: string,
    requestId: string,
    optionId: string,
    approver: ApproverIdentity,
  ) => Promise<void>;
  /** Whether `approver` (the viewing user) may act on this request; fails closed broker-side and defaults to allowed when unwired. */
  canApproveRequest?: (
    sessionId: string,
    contrib: string,
    requestId: string,
    approver: ApproverIdentity,
  ) => Promise<boolean>;
  /** Model catalog for per-conversation selection; an empty `available` list means only the default is selectable. */
  models?: {
    default?: string;
    available: string[];
    hints?: Record<string, string>;
    /** Model id to the provider tags offering it ([] = every provider). */
    providers?: Record<string, string[]>;
    /** Model id to the provider tags this model is the default for, so the UI can label
     *  "(default)" per provider group. */
    defaultFor?: Record<string, string[]>;
    /** Model and provider an unset conversation's run uses for `owner`. */
    resolveDefault?: (
      owner: string | undefined,
      conversationId: string | undefined,
    ) => Promise<{ model: string | undefined; provider: string | undefined }>;
  };
  /** Raw handler for the agent-self-modify MCP endpoint, which writes the response itself. */
  mcpHandler?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;
  /** The webhooks conversation_map lookup served at GET /conversations/:id/resource-map; absent when no webhooks DSN is configured. */
  resourceLookup?: { lookup(conversationId: string, source: string): Promise<unknown | undefined> };
  /** The broker-MCP proxy handler; absent when the broker or the conversation-token secret is not configured. */
  brokerMcpHandler?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;
  /** Upload caps served to the UI in /whoami's `limits` block (scooter.uploads). */
  uploadLimits?: { maxFileBytes: number; maxFilesPerMessage: number };
  /** Resolves the caller's identity per request; defaults to the env-configured resolver. */
  resolveUser?: ResolveUser;
  /** Whether a request is a trusted in-cluster caller (webhooks/scheduler) allowed to set a body `owner`; absent means a body owner is never honored. */
  ownerVerifier?: (req: IncomingMessage) => Promise<boolean>;
  /** The visibility check guarding every /conversations/:id route; absent means no guard (tests). */
  accessCheck?: AccessCheck;
  /** AUTH_ENFORCE: the router proves every user, so anonymous is never the single user. */
  authEnforced?: boolean;
  /** In-pod web-service registry powering the UI Services panel; absent in fake/local mode. */
  webServices?: WebServiceRegistry;
  /** Per-conversation service origins (SANDBOX_DOMAIN); absent keeps services under /c/<id>/. */
  sandboxOrigins?: SandboxOrigins;
  /** Identity store for the email-to-user reverse lookup; absent means the lookup route reports no match. */
  identityStore?: IdentityStore;
  /** Uploaded-image store behind GET /conversations/:id/assets/:assetId; absent means images are off. */
  assets?: AssetStore;
  /** Scheduler client for the settings page's scheduled-tasks CRUD, always scoped to the caller; absent means the routes report it unconfigured. */
  scheduler?: SchedulerClient;
  /** Owner lookup for task targets; absent refuses any target. */
  conversationOwner?: ConversationOwnerLookup;
  /** Personal-skills store for the settings page's CRUD, always scoped to the caller; absent (no agent_host DSN) means the routes report it unconfigured. */
  userSkills?: UserSkillStore;
  /** The deployment's hooks, listed on the settings page. */
  hooks?: readonly HookDef[];
  /** Per-user hook opt-outs; absent makes the toggles read-only. */
  userHookSettings?: UserHookSettingsStore;
  /** The /contrib-api relay for contrib settings tabs; absent means the routes are not mounted. */
  contribApi?: ContribApiDeps;
  /** The deployment skills' names, so the settings form can warn that a personal skill of the same name replaces one. */
  builtinSkillNames?: () => string[];
  /** Summarize older turns and continue on summary+recent; null when too short to compact, throws on summarizer failure. */
  compact?: (conversationId: string) => Promise<{ summarizedTurns: number; keptRuns: number } | null>;
  /** The conversation's current sandbox resource requests/limits; wired only on the broker path. */
  sandboxResources?: (conversationId: string) => Promise<SandboxResources | undefined>;
  /** The named sandbox size presets and the default preset name; wired only on the broker path. */
  sandboxSizes?: () => Promise<{ sizes: Record<string, SandboxSizePreset>; default: string | null }>;
  /** Record a named size preset for a conversation, rejecting unknown names; absent means the route reports 501. */
  setSandboxSize?: (conversationId: string, size: string) => Promise<void>;
  /** Bring-your-own-Claude support for the Settings "Connect your Claude agent" section; absent when REMOTE_AGENT_JOIN_SECRET is unset, so the UI hides it. */
  remoteAgent?: {
    /** Mint a fresh owner-bound join token plus the docker one-liner; async because the session is minted on the controller. */
    mint(owner: string): Promise<{ token: string; dockerCommand: string; wsUrl: string }>;
    /** Whether the owner's agent is connected, plus their most recent rejected connection attempt. */
    status(owner: string): Promise<{ connected: boolean; lastAuthFailure: { reason: string; at: string } | null }>;
    /** Whether this owner's remote agent is connected right now (durable via the DB when one is wired). */
    isConnected(owner: string): Promise<boolean>;
  };
}

/**
 * One pending approval, as a contrib's broker half describes it. `message` arrives
 * already rendered by the contrib, the side that knows what it is asking for.
 * snake_case because it is the broker's wire shape, passed through verbatim.
 */
export interface ApprovalRequest {
  request_id: string;
  /** What the human reads; rendered by the contrib, opaque here. */
  message?: string;
  /** Optional override of the Approve/Deny pair (the shape raiseInterrupt takes). */
  options?: Array<{ optionId: string; name: string; kind: string }>;
  /** The renderer key a contrib card draws this request with, e.g. "aws.permissions". */
  kind?: string;
  /** The full request for that card; opaque here. */
  data?: unknown;
}

/** Where a contrib's approval verbs live on the broker, from APPROVAL_CONTRIBS_JSON. */
export interface ApprovalContrib {
  /** Prefix the verbs hang off, e.g. "/aws/aws" for `/{id}/approve|deny|can-approve`. */
  brokerPrefix: string;
  /** Where to list still-pending requests for a conversation; null means no re-raise. */
  pendingPath?: string | null;
}

/** The default verbs, the pair the UI's gating (`gatedOption` in the contrib manifest) understands. */
export const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<{ optionId: string; name: string; kind: string }> = [
  { optionId: "approve", name: "Approve", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

/** Query the broker for a conversation's still-pending approval requests, keyed by the
 *  sandbox short-id (`shortId(threadId)`) rather than the thread UUID; returns [] on any error. */
export async function fetchPendingApprovals(
  brokerUrl: string,
  pendingPath: string,
  brokerConversationId: string,
  authHeaders: Record<string, string>,
  onWarn?: (status: number) => void,
): Promise<ApprovalRequest[]> {
  const base = brokerUrl.replace(/\/$/, "");
  if (!base || !pendingPath) return [];
  const res = await fetch(
    `${base}${pendingPath}?conversation_id=${encodeURIComponent(brokerConversationId)}`,
    { method: "GET", headers: authHeaders },
  );
  if (!res.ok) {
    // 404/501 means the contrib is not configured on this broker; anything else is logged but not fatal.
    if (res.status !== 404 && res.status !== 501) onWarn?.(res.status);
    return [];
  }
  const body = (await res.json().catch(() => ({}))) as { requests?: ApprovalRequest[] };
  return (body.requests ?? []).filter((r) => r.request_id);
}

/** Raise the Approve/Deny interrupt for a contrib's approval request on a conversation's
 *  bridge, the one builder shared by the POST approvals route and the revive re-raise so
 *  both produce an identical interrupt. */
export function raiseApprovalInterrupt(
  bridge: SessionBridge,
  conversationId: string,
  contrib: string,
  req: ApprovalRequest,
  resolveApproval?: ManagementDeps["resolveApproval"],
): void {
  bridge.raiseInterrupt({
    id: req.request_id,
    // An empty contrib-rendered message would leave the user a pair of buttons with nothing to decide on.
    message: req.message || `${contrib} is requesting approval (no description provided).`,
    options: [...(req.options ?? DEFAULT_APPROVAL_OPTIONS)],
    // `contrib` is the name the UI looks up in the manifest for which option to grey; requestId
    // is carried explicitly so the UI need not assume it equals the interrupt id.
    metadata: {
      contrib,
      requestId: req.request_id,
      ...(req.kind ? { kind: req.kind, data: req.data } : {}),
    },
    onAnswer: (optionId, approver) => {
      // The approver is the human who answered; the conversation-id fallback exists only
      // for anonymous deployments where there is no human to name.
      const approverIdentity = approver ?? { id: conversationId };
      // A dismiss (null optionId) relays nothing: the request stays pending in the broker
      // and the revive re-raise brings the window back.
      if (optionId === null) {
        log.info("approval dismissed without an answer; leaving it pending", {
          conversation_id: conversationId,
          contrib,
          request_id: req.request_id,
        });
        return;
      }
      // resolveApproval throws on a dropped answer, and a swallowed rejection would silently
      // lose the user's security decision.
      void resolveApproval?.(conversationId, contrib, req.request_id, optionId, approverIdentity).catch(
        (err) => {
          log.errorWith("approval NOT recorded", err, {
            conversation_id: conversationId,
            contrib,
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

  // Every /conversations/:id route answers 404 for a private conversation the caller may not
  // see: the same answer as a missing one, so its existence does not leak.
  if (deps.accessCheck) {
    const check = deps.accessCheck;
    r.guard(async (ctx) => {
      const id = ctx.params.id;
      if (!id || !(ctx.req.url ?? "").startsWith("/conversations/")) return undefined;
      try {
        return (await check(id, ctx.req, ctx.user)) === "deny" ? { status: 404, json: { error: "not found" } } : undefined;
      } catch (err) {
        log.errorWith("visibility check failed; refusing", err, { conversation_id: id });
        return { status: 503, json: { error: "could not check access" } };
      }
    });
  }

  // The agent-self-modify MCP endpoint; the StreamableHTTP transport owns the response,
  // so the handler returns void.
  if (deps.mcpHandler) {
    const mcp = deps.mcpHandler;
    const mcpRoute = async (ctx: { req: IncomingMessage; res: ServerResponse; body: <T>() => Promise<T> }) => {
      const body = await ctx.body<unknown>().catch(() => undefined);
      await mcp(ctx.req, ctx.res, body);
    };
    r.post("/mcp", mcpRoute as never);
    r.get("/mcp", mcpRoute as never); // MCP also uses GET for the SSE stream
  }

  // The broker-MCP proxy, the agent's route to the contrib tools, with the same shape as /mcp.
  if (deps.brokerMcpHandler) {
    const proxy = deps.brokerMcpHandler;
    const route = async (ctx: { req: IncomingMessage; res: ServerResponse; body: <T>() => Promise<T> }) => {
      const body = await ctx.body<unknown>().catch(() => undefined);
      await proxy(ctx.req, ctx.res, body);
    };
    r.post("/broker-mcp", route as never);
    r.get("/broker-mcp", route as never);
  }

  // The caller per the trusted ingress identity header (anonymous when none).
  r.get("/whoami", (ctx) => ({
    json: {
      id: ctx.user.id,
      email: ctx.user.email ?? null,
      anonymous: ctx.user.anonymous,
      ...(deps.uploadLimits ? { limits: { ...deps.uploadLimits } } : {}),
    },
  }));

  // --- Bring-your-own-Claude: connect a personal Claude agent ------------------
  // Owner-scoped (ctx.user.id); 404 when BYO is not enabled so the UI hides the section,
  // 401 for an anonymous caller since an agent must bind to a real user.
  r.post("/remote-agent/join-token", async (ctx) => {
    if (!deps.remoteAgent) return { status: 404, json: { error: "remote agents not enabled" } };
    if (ctx.user.anonymous) return { status: 401, json: { error: "sign in to connect a Claude agent" } };
    // An unreachable BYOC controller is an expected, diagnosable condition, answered as
    // JSON here rather than left to the outer handler.
    try {
      const { token, dockerCommand, wsUrl } = await deps.remoteAgent.mint(ctx.user.id);
      return { json: { token, dockerCommand, wsUrl } };
    } catch (err) {
      remoteAgentLog.errorWith("join-token mint failed", err, { user_id: ctx.user.id });
      // Name the dependency without echoing err.message, since an error response must never
      // carry token material or internals.
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
    // status() carries the owner's most recent rejected connection attempt so a failed
    // container does not look like one never started.
    const st = await deps.remoteAgent.status(ctx.user.id);
    return { json: { connected: st.connected, owner: ctx.user.id, lastAuthFailure: st.lastAuthFailure } };
  });

  // Reverse identity lookup for the webhooks service: the Scooter user id for an exact
  // email, 404 otherwise.
  r.get("/users/by-email", async (ctx) => {
    const email = (ctx.query.get("email") ?? "").trim();
    if (!email) return { status: 400, json: { error: "email required" } };
    const match = deps.identityStore ? await deps.identityStore.getByEmail(email).catch(() => undefined) : undefined;
    if (!match) return { status: 404, json: { error: "no user with that email" } };
    return { json: { id: match.id } };
  });

  // The learned Scooter users (those who have signed in or been mapped via a webhook) for
  // the settings Users page; 501 when no identity store is wired so the UI can hide the page.
  r.get("/users", async () => {
    if (!deps.identityStore) return { status: 501, json: { error: "identity store not configured" } };
    const users = await deps.identityStore.list().catch(() => []);
    return { json: { configured: true, users } };
  });

  // The model catalog a UI populates its selector from.
  r.get("/models", async (ctx) => {
    // `?conversation=` breaks priority ties as that conversation's runs do.
    const resolved = await models
      .resolveDefault?.(ctx.user.anonymous ? undefined : ctx.user.id, ctx.query.get("conversation") ?? undefined)
      .catch((err) => void log.errorWith("resolving the default model failed", err));
    return {
      json: {
        default: resolved?.model ?? models.default ?? null,
        // The provider serving that default, so the UI labels it under the right group.
        defaultProvider: resolved?.provider ?? null,
        available: models.available,
        hints: models.hints ?? {},
        // Lets the UI label which choices apply to the BYO container vs the cloud floor.
        providers: models.providers ?? {},
        // Model id to the providers it is the default for, so the UI can mark "(default)" per group.
        defaultFor: models.defaultFor ?? {},
      },
    };
  });

  // Create a conversation with a server-minted id (a client-chosen id would become an
  // event-log key and a k8s resource name); in multi-replica the conversation-router serves
  // this path itself, so this route serves single-replica deployments and e2e.
  r.post("/conversations", async (ctx) => {
    const body = await ctx.body<{ title?: string; model?: string; owner?: string; visibility?: unknown }>();
    if (body.visibility !== undefined && !isVisibility(body.visibility)) {
      return { status: 400, json: { error: "visibility must be shared or private" } };
    }
    // Reject an unknown model rather than silently falling back.
    if (body.model && body.model !== models.default && !models.available.includes(body.model)) {
      return { status: 400, json: { error: `unknown model: ${body.model}` } };
    }
    // Stamp the creating user as the owner; a body `owner` wins only for a verified in-cluster caller.
    let owner = ctx.user.anonymous ? undefined : ctx.user.id;
    const bodyOwner = typeof body.owner === "string" ? body.owner.trim() : "";
    if (bodyOwner && bodyOwner !== owner) {
      if (deps.ownerVerifier && (await deps.ownerVerifier(ctx.req).catch(() => false))) {
        owner = bodyOwner;
      } else {
        log.warn("ignored a body owner from an unverified caller", { had_header_owner: owner !== undefined });
      }
    }
    if (body.visibility === "private" && !owner) {
      return { status: 400, json: { error: "a private conversation needs a signed-in owner" } };
    }
    const conv = await sessions.start(randomUUID(), body.model, owner, { visibility: body.visibility ?? "shared" });
    if (body.title) sessions.setTitle(conv.id, body.title);
    return { status: 201, json: view(sessions.get(conv.id)!) };
  });

  // GET /conversations and its events stream are fleet-wide, so the conversation-router
  // serves both from Postgres (services/conversation-router/{list,events}.go).

  r.get("/conversations/:id", async (ctx) => {
    // Hydrate-if-absent (read-only) so a reconnect after a pod move resolves instead of 404ing.
    let conv = sessions.get(ctx.params.id);
    if (!conv && (await sessions.ensureReadable(ctx.params.id))) conv = sessions.get(ctx.params.id);
    if (!conv) return { status: 404, json: { error: "not found" } };
    // Star and title are router-written; serve the durable values.
    await sessions.refreshRouterMeta(conv.id).catch(() => {});
    return { json: view(sessions.get(conv.id) ?? conv) };
  });

  r.del("/conversations/:id", async (ctx) => {
    // Hydrate-if-absent so a DELETE routed to a pod not holding the conversation still
    // destroys it instead of leaking the sandbox.
    let conv = sessions.get(ctx.params.id);
    if (!conv && (await sessions.ensureReadable(ctx.params.id))) conv = sessions.get(ctx.params.id);
    if (!conv) return { status: 404, json: { error: "not found" } };
    // A starred conversation is protected from deletion; the caller must unstar first.
    await sessions.refreshRouterMeta(conv.id);
    if (sessions.get(conv.id)?.starred) return { status: 409, json: { error: "conversation is starred; unstar before deleting" } };
    await sessions.end(ctx.params.id);
    return { status: 204, json: null };
  });

  // The write boundary: only the owner, an anonymous single-user caller, or anyone for an
  // unowned conversation may mutate, the same inclusion rule as the "mine" view filter.
  const mutableFor = (id: string, user: { anonymous: boolean; id: string }) => {
    const conv = sessions.get(id);
    if (!conv) return { conv: undefined as Conversation | undefined, error: 404 as const };
    // Without AUTH_ENFORCE, anonymous is single-user mode and may mutate any conversation.
    const singleUser = user.anonymous && !deps.authEnforced;
    if (!singleUser && conv.owner && conv.owner !== user.id) {
      return { conv: undefined, error: 403 as const };
    }
    return { conv, error: undefined };
  };

  // Owner only, both ways. Going shared exposes everything Scooter fetched while private, so it
  // needs `confirm: true` (the UI's warning dialog sets it). A subagent follows its root.
  r.patch("/conversations/:id/visibility", async (ctx) => {
    if (!sessions.get(ctx.params.id)) await sessions.ensureReadable(ctx.params.id);
    const conv = sessions.get(ctx.params.id);
    if (!conv) return { status: 404, json: { error: "not found" } };
    const body = await ctx.body<{ visibility?: unknown; confirm?: unknown }>();
    if (!isVisibility(body.visibility)) {
      return { status: 400, json: { error: "visibility must be shared or private" } };
    }
    if (ctx.user.anonymous || !conv.owner || conv.owner !== ctx.user.id) {
      return { status: 403, json: { error: "only the owner can change visibility" } };
    }
    if (conv.parentId) return { status: 409, json: { error: "a subagent takes its parent's visibility" } };
    // Fresh, not memory: the router or another replica may have changed it.
    const current = (await store.readAccess?.(conv.id))?.visibility ?? conv.visibility ?? "shared";
    if (body.visibility === "shared" && current === "private" && body.confirm !== true) {
      return { status: 409, json: { error: "making a private conversation shared needs confirm: true" } };
    }
    await sessions.setVisibility(conv.id, body.visibility);
    return { json: view(sessions.get(conv.id)!) };
  });

  r.post("/conversations/:id/suspend", async (ctx) => {
    // Hydrate-if-absent so suspend reaches the conversation whichever replica answers.
    if (!sessions.get(ctx.params.id) && (await sessions.ensureReadable(ctx.params.id))) {
      /* hydrated into memory */
    }
    if (!sessions.get(ctx.params.id)) return { status: 404, json: { error: "not found" } };
    await sessions.suspend(ctx.params.id);
    return { json: view(sessions.get(ctx.params.id)!) };
  });

  // Restarts the sandbox; 409 while another run uses it.
  r.post("/conversations/:id/restart", async (ctx) => {
    if (!sessions.restartSandbox) return { status: 501, json: { error: "sandbox restart unavailable" } };
    if (!sessions.get(ctx.params.id)) await sessions.ensureReadable(ctx.params.id);
    const { conv, error } = mutableFor(ctx.params.id, ctx.user);
    if (error === 404) return { status: 404, json: { error: "not found" } };
    if (error === 403) return { status: 403, json: { error: "not your conversation" } };
    try {
      const result = await sessions.restartSandbox(conv!.id as SessionId);
      return { json: result };
    } catch (e) {
      if ((e as { code?: number }).code === 409) return { status: 409, json: { error: (e as Error).message } };
      throw e;
    }
  });

  r.post("/conversations/:id/resume", async (ctx) => {
    if (!sessions.get(ctx.params.id)) return { status: 404, json: { error: "not found" } };
    await sessions.revive(ctx.params.id);
    return { json: view(sessions.get(ctx.params.id)!) };
  });

  // Cluster-internal revive-on-assign: the controller POSTs this on a conversation's new
  // host right after reassigning it so history replays from the shared mirror before user
  // traffic arrives, hydrating if absent, idempotent, and fenced on the row generation in `gen`.
  r.post("/internal/revive/:id", async (ctx) => {
    const gen = Number(new URL(ctx.req.url ?? "", "http://x").searchParams.get("gen") ?? "0");
    // 202 rather than 200 so a caller can tell it is an async pre-warm, not a synchronous revive.
    await sessions.reviveFromMirror(ctx.params.id, Number.isFinite(gen) ? gen : 0);
    return { status: 202, json: { revived: ctx.params.id } };
  });

  // Manual compaction: summarize and persist the marker first (a summarizer failure is a
  // 502 with the conversation untouched), then revive so the next turn runs on the
  // compacted context.
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
    const body = await ctx.body<{ text?: string; source?: string }>();
    if (!body.text) return { status: 400, json: { error: "text required" } };
    if (body.source !== undefined && !isPostableSource(body.source)) {
      return { status: 400, json: { error: "source must be a lowercase name, not a human or reserved source" } };
    }
    // Interrupts at the next tool-call boundary: queued until the run ends, it would land out of order.
    // 202 once queued, not once the run ends: a caller that gave up waiting on a long turn
    // would resend a message the agent already has.
    // A sandbox's message always carries a non-human source.
    const fromSandbox = ctx.req.headers[SANDBOX_CALLER_HEADER] === "sandbox";
    const source = body.source || (fromSandbox ? SANDBOX_SOURCE : undefined);
    await sessions.enqueueByThread(ctx.params.id, body.text, source, PRIORITY_INTERRUPT);
    return { status: 202, json: { ok: true } };
  });

  // Stop the running turn (the UI's Stop button); a conversation with no live bridge or
  // nothing running still returns 202 so a stale Stop click never errors.
  r.post("/conversations/:id/cancel", async (ctx) => {
    const conv = sessions.get(ctx.params.id);
    if (!conv) return { status: 404, json: { error: "not found" } };
    // Record whether a bridge existed, since the no-bridge no-op is otherwise
    // indistinguishable from a real stop.
    log.info("cancel requested", {
      conversation_id: ctx.params.id,
      has_bridge: conv.bridge !== undefined,
      status: conv.status,
    });
    await conv.bridge?.cancel(undefined, true);
    return { status: 202, json: { ok: true } };
  });

  r.get("/conversations/:id/history", async (ctx) => {
    // Return events plus the rolling integrity checksum through the last one so a streaming
    // client can verify it replayed the complete log; stores without the checksum variant
    // fall back to chaining.
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

  // Stream an uploaded image back; the assetId is only readable under its own conversation
  // id, and the handler writes the binary response itself.
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
      // The assetId is content-addressed, so the bytes never change.
      "Cache-Control": "private, max-age=31536000, immutable",
    });
    res.end(asset.data);
  });

  r.get("/conversations/:id/tail", async (ctx) => {
    // A fast first-paint window bounded by event count (`limit`, default 300), or by `runs`
    // for run-aligned windows.
    const limitParam = Number(ctx.query.get("limit"));
    const runsParam = Number(ctx.query.get("runs"));
    const wantRuns = Number.isFinite(runsParam) && runsParam > 0;

    let events: AguiEvent[];
    if (wantRuns && store.readEventsTail) {
      events = await store.readEventsTail(ctx.params.id, Math.min(runsParam, 100));
    } else if (!wantRuns && store.readEventsTailByCount) {
      const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 2000) : 300;
      events = await store.readEventsTailByCount(ctx.params.id, limit);
    } else {
      // Stores without a tail reader (in-memory tests) have tiny logs.
      const all: AguiEvent[] = [];
      for await (const e of store.readEvents(ctx.params.id)) all.push(e);
      events = wantRuns ? tailByRuns(all, Math.min(runsParam, 100)) : trimToBoundary(all.slice(-300));
    }
    return { json: { events, ...(wantRuns ? { runs: Math.min(runsParam, 100) } : {}) } };
  });

  r.get("/conversations/:id/messages", async (ctx) => {
    // Older history paged backwards for the scroll-up load: the reply is the window
    // immediately before seq `before`, folded to messages.
    const before = Number(ctx.query.get("before"));
    const limitParam = Number(ctx.query.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 5000) : 1200;
    if (!Number.isFinite(before) || before <= 1) {
      return { json: { messages: [], fromSeq: 1, done: true } };
    }
    if (!store.readEventsBefore) {
      // No paging reader (in-memory tests): serve from the full log.
      const all: AguiEvent[] = [];
      for await (const e of store.readEvents(ctx.params.id)) all.push(e);
      const end = Math.max(0, Math.min(before - 1, all.length));
      const start = Math.max(0, end - limit);
      const window = all.slice(start, end);
      const drop = start === 0 ? 0 : alignPageToRun(window);
      return {
        json: {
          messages: foldToMessages(window.slice(drop)),
          fromSeq: start + 1 + drop,
          done: start === 0,
        },
      };
    }
    const { events, firstSeq, done } = await store.readEventsBefore(ctx.params.id, before, limit);
    // Start the page at a run boundary so a run split across the seam is folded by exactly one page.
    const drop = done ? 0 : alignPageToRun(events);
    return {
      json: {
        messages: foldToMessages(events.slice(drop)),
        fromSeq: firstSeq + drop,
        done,
      },
    };
  });

  r.get("/conversations/:id/events", async (ctx) => {
    // Make history local first (a reconnect may land on a non-owner pod) so onAttach replays the full log.
    if (!sessions.get(ctx.params.id)) await sessions.ensureReadable(ctx.params.id);
    // SSE: the server owns the connection and returns no JSON result.
    await server.subscribeSSE(ctx.params.id, ctx.res);
  });

  // Integrity stream: replay the full log with rolling checksums as plain JSON SSE (not the
  // @ag-ui encoder), then forward live appends, so the client detects a gap via
  // prevChecksum and refetches history.
  r.get("/conversations/:id/events.integrity", async (ctx) => {
    const id = ctx.params.id;
    const { res } = ctx;
    // Make history readable on this pod first (the owner may have moved after a rollout),
    // and 404 only if the conversation is unknown anywhere so the client stops reconnecting
    // for a deleted one.
    if (!sessions.get(id) && !(await sessions.ensureReadable(id))) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const send = (frame: unknown) => res.write(`data: ${JSON.stringify(frame)}\n\n`);

    // Subscribe to live appends before replaying, buffering until replay is done and
    // deduping by checksum.
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

    // Flush pending fire-and-forget appends before replaying, so a just-sent message still
    // mid-write lands in the replay or the pre-live buffer rather than neither.
    await store.flush?.(id);

    // Called through `store` because these methods use `this`.
    const replay = store.readEventsWithChecksum
      ? (i: SessionId) => store.readEventsWithChecksum!(i)
      : undefined;
    if (replay) {
      // History goes as one snapshot rather than N events, since the client's applier
      // rebuilds and clones the message list per event; events carrying no message state
      // still replay individually.
      const history: AguiEvent[] = [];
      for await (const c of replay(id)) {
        seen.add(c.checksum);
        history.push(c.event);
      }
      // Only the trailing window is painted up front; older history pages in on scroll.
      const { tail, fromSeq, hasOlder } = splitForInitialSnapshot(history);
      const messages = foldToMessages(tail);
      if (messages.length > 0) {
        send({
          kind: "event",
          event: { type: "MESSAGES_SNAPSHOT", messages, ...(hasOlder ? { fromSeq } : {}) },
        });
      }
      // A SYSTEM_MESSAGE's position among the folded messages is lost once history is a snapshot, so
      // stamp each one with the folded message it followed. Folded over the full history (not just
      // the tail) so the ids match older pages too.
      const anchors = new Map<string, string | null>();
      if (history.some((e) => e.type === "SYSTEM_MESSAGE")) foldToMessages(history, anchors);
      // Non-message events replay from the full history because run/queue/context state is cumulative.
      for (const e of history) {
        if (MESSAGE_EVENTS.has(e.type)) continue;
        const id = e.type === "SYSTEM_MESSAGE" ? (e as { messageId?: string }).messageId : undefined;
        send({ kind: "event", event: id && anchors.has(id) ? { ...e, afterMessageId: anchors.get(id) } : e });
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
    // Mark the end of the initial replay so the client knows it is caught up.
    send({ kind: "synced" });

      // This stream only carries live events for a conversation this pod runs, so when
      // another pod owns it end the stream after replay (and re-check periodically) so the
      // client's reconnect goes back through the router.
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

    // SSE heartbeat: an idle conversation emits no events, so send an SSE comment line every
    // 25s to keep every proxy layer's read timeout from dropping the stream.
    const heartbeat = setInterval(() => {
      // res.write can throw if the socket is already gone.
      try { res.write(": ping\n\n"); } catch { /* connection closed */ }
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
    // The broker authorizes the answering user, not the conversation owner; anonymous
    // means no identity claims.
    const approver = ctx.user.anonymous
      ? undefined
      : { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name };
    await deps.answerPermission(ctx.params.id, ctx.params.toolCallId, body.optionId, approver);
    return { status: 204, json: null };
  });

  // Whether the current viewer may act on this request, per viewer since one interrupt is
  // seen by many users; anonymous users can never approve.
  r.get("/conversations/:id/approvals/:contrib/:requestId/can-approve", async (ctx) => {
    if (!deps.canApproveRequest) return { json: { canApprove: true } }; // unwired → don't block
    if (ctx.user.anonymous) return { json: { canApprove: false } };
    const approver = { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name };
    const canApprove = await deps
      .canApproveRequest(ctx.params.id, ctx.params.contrib, ctx.params.requestId, approver)
      .catch(() => false); // fail closed (greyed) on any error
    return { json: { canApprove } };
  });

  // External resource links (the GitHub PR / Slack thread a conversation came from): the
  // webhooks service POSTs them on create and the UI GETs them.

  // Resolve an id that may be the broker's short DNS hash (`sandbox-{shortId}`) rather than
  // the full threadId the store keys by.
  const resolveConvId = async (id: string): Promise<string | null> => {
    const conv = sessions.get(id) ?? (await sessions.getByShortId(id));
    return conv?.id ?? null;
  };
  // resolveConvId plus a refresh of a hydrated entry's Sandbox ref, for the routes that exec into
  // the pod: a stale placeholder ref reads as "no services" and "suspended" on a running sandbox.
  const resolveLiveConvId = async (id: string): Promise<string | null> => {
    const convId = await resolveConvId(id);
    if (convId) await sessions.refreshSandbox?.(convId as SessionId);
    return convId;
  };

  // The webhooks `conversation_map` row for a conversation, the fallback target source for
  // a provider reply tool whose link has neither a usable `ref` nor a parseable URL; served
  // here because the broker must not read the webhooks table directly, and kept out of
  // GET /links so the UI shows no phantom links.
  r.get("/conversations/:id/resource-map", async (ctx) => {
    if (!deps.resourceLookup) return { json: { mappings: [] } };
    const source = ctx.query.get("source") ?? "";
    const sources = source ? [source] : ["slack", "github", "gitlab", "jira"];
    const mappings = (
      await Promise.all(
        sources.map((s) =>
          deps
            .resourceLookup!.lookup(ctx.params.id, s)
            .catch(() => undefined),
        ),
      )
    ).filter((m): m is NonNullable<typeof m> => m !== undefined);
    return { json: { mappings } };
  });

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
    // Fall back to the raw path id because a link may be registered before the conversation
    // materializes (the Slack webhook posts the thread link before /agui creates the
    // session), and the store keys by the full threadId the webhook posts.
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

  // Web services (marimo/xterm/vscode) declared in the sandbox and reverse-proxied at
  // /c/<id>/<name>/; the UI Services panel lists and starts them.

  // Actual pod readiness: `status` can be "running" while the pod is still
  // ContainerCreating, and exec succeeds only once the pod is Ready.
  r.get("/conversations/:id/ready", async (ctx) => {
    const id = await resolveLiveConvId(ctx.params.id);
    const conv = id ? sessions.get(id) : undefined;
    // Only a running-status conversation can be ready.
    if (!id || !conv || conv.status !== "running" || !deps.webServices) {
      return { json: { ready: false, status: conv?.status ?? "unknown" } };
    }
    const ready = await deps.webServices.ready(id).catch(() => false);
    return { json: { ready, status: conv.status } };
  });

  r.get("/conversations/:id/web-services", async (ctx) => {
    const id = await resolveLiveConvId(ctx.params.id);
    if (!id || !deps.webServices) return { json: { services: [] } };
    // ?refresh=1 re-reads the in-pod manifest, since nothing in the pod signals a `scooter-rebuild`.
    const force = ctx.query.get("refresh") === "1";
    // An unlisted service is a backend another one frames (marimo's server); it stays proxied.
    const services = (await deps.webServices.list(id, { force })).filter((s) => s.visibleInMenu !== false);
    // One size read for the whole list; absent (fake mode / no broker) leaves every `fit`
    // undefined, which the UI renders as no warning.
    const size = deps.sandboxResources ? await deps.sandboxResources(id).catch(() => undefined) : undefined;
    const withState = await Promise.all(
      services.map(async (s) => ({
        name: s.name,
        displayName: s.displayName,
        // The conversation's own services origin when configured, else the main-host path.
        url: serviceUrl(sessions.get(id)?.threadId ?? id, s.name, deps.sandboxOrigins),
        running: await deps.webServices!.isRunning(id, s.name).catch(() => false),
        resources: s.resources,
        // `fitShort` fits the card; `fit` is the full sentence shown on hover.
        fit: s.resources ? fitAdvice(s.displayName, s.resources, size) : undefined,
        fitShort: s.resources ? fitSummary(s.resources, size) : undefined,
      })),
    );
    return { json: { services: withState } };
  });

  // The sandbox's current resource allotment for the Sandbox tab; an absent getter yields
  // {resources: null}.
  r.get("/conversations/:id/resources", async (ctx) => {
    const id = await resolveConvId(ctx.params.id);
    if (!id) return { json: { resources: null, pendingRestart: null } };
    // What a restart would pick up; best-effort.
    const [resources, pendingRestart] = await Promise.all([
      deps.sandboxResources ? deps.sandboxResources(id).catch(() => undefined) : undefined,
      sessions.get(id) && sessions.pendingRestart ? sessions.pendingRestart(id as SessionId).catch(() => undefined) : undefined,
    ]);
    return { json: { resources: resources ?? null, pendingRestart: pendingRestart ?? null } };
  });

  // The named sandbox size presets and the default preset name; an absent getter yields
  // {sizes: {}, default: null}.
  r.get("/sandbox-sizes", async () => {
    if (!deps.sandboxSizes) return { json: { sizes: {}, default: null } };
    const result = (await deps.sandboxSizes().catch(() => ({ sizes: {}, default: null })));
    return { json: result };
  });

  // Pick a size preset by name for this conversation (the raw-resources path stays
  // agent-only), taking effect on the next sandbox restart.
  r.patch("/conversations/:id/size", async (ctx) => {
    if (!deps.setSandboxSize) return { status: 501, json: { error: "sandbox sizing unavailable" } };
    // Hydrate-if-absent so a size write against an idle conversation does not 404.
    if (!sessions.get(ctx.params.id)) await sessions.ensureReadable(ctx.params.id);
    // Resizing changes what the cluster reserves, so it follows the same mutableFor gate
    // as the other mutations.
    const { conv, error } = mutableFor(ctx.params.id, ctx.user);
    if (error === 404) return { status: 404, json: { error: "not found" } };
    if (error === 403) return { status: 403, json: { error: "not your conversation" } };
    const size = (await ctx.body<{ size?: unknown }>().catch(() => undefined))?.size;
    if (typeof size !== "string" || !size.trim()) {
      return { status: 400, json: { error: "body must be {size: \"<preset-name>\"}" } };
    }
    try {
      await deps.setSandboxSize(conv!.id, size.trim());
    } catch (e) {
      // Surface the broker's validation message (e.g. the available presets) rather than a bare 500.
      return { status: 400, json: { error: (e as Error).message } };
    }
    return { json: { size: size.trim() } };
  });

  r.post("/conversations/:id/web-services/:name/start", async (ctx) => {
    const id = await resolveLiveConvId(ctx.params.id);
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
    const id = await resolveLiveConvId(ctx.params.id);
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

  // A contrib's broker half calls this to raise an in-conversation approval interrupt
  // whose answer routes back via deps.resolveApproval; `:contrib` is not validated here so
  // a contrib deployed slightly ahead of the agent-host can still raise.
  r.post("/conversations/:id/approvals/:contrib", async (ctx) => {
    const body = await ctx.body<{
      request_id?: string;
      message?: string;
      options?: Array<{ optionId: string; name: string; kind: string }>;
    }>();
    if (!body.request_id) return { status: 400, json: { error: "request_id required" } };
    // The broker identifies the conversation by the short DNS-safe hash from the sandbox
    // SA name rather than the full threadId, so fall back to short-id resolution (which
    // also hydrates an evicted conversation).
    const conv =
      sessions.get(ctx.params.id) ?? (await sessions.getByShortId(ctx.params.id));
    if (!conv) {
      return { status: 404, json: { error: "unknown conversation" } };
    }
    // The bridge may be absent (idle-suspended, hydrated-but-not-revived, or torn down by
    // a model switch) while the agent is still blocked on the answer, so revive to rebuild
    // it, keyed by the resolved conv.id rather than the possibly-short path id.
    let bridge = sessions.get(conv.id)?.bridge;
    if (!bridge) {
      try {
        await sessions.revive(conv.id);
        bridge = sessions.get(conv.id)?.bridge;
      } catch (err) {
        log.errorWith("approval request could not revive", err, {
          conversation_id: conv.id,
          contrib: ctx.params.contrib,
        });
      }
    }
    if (!bridge) return { status: 503, json: { error: "could not activate conversation to raise the approval" } };

    raiseApprovalInterrupt(bridge, conv.id, ctx.params.contrib, body as ApprovalRequest, deps.resolveApproval);
    return { status: 202, json: { ok: true } };
  });

  // --- Scheduled tasks (UI settings page) ----------------------------------------
  // Proxy CRUD to the scheduler scoped to the caller (x-auth-user = the caller's id, or
  // null for the anonymous bucket); 501 without a scheduler.
  const scheduler = deps.scheduler;
  const scopeOwner = (ctx: { user: { anonymous: boolean; id: string } }) =>
    ctx.user.anonymous ? null : ctx.user.id;
  const noScheduler = { status: 501, json: { error: "scheduler not configured" } };
  // Why the caller can't target this; undefined if allowed.
  const badTarget = async (owner: string | null, target: unknown): Promise<string | undefined> => {
    if (target === undefined || target === null || target === "") return undefined;
    if (typeof target !== "string") return "conversation_id must be a string";
    if (!deps.conversationOwner) return "targeting a conversation is not supported here";
    return targetError(deps.conversationOwner, owner, target);
  };

  r.get("/scheduled-tasks", async (ctx) => {
    if (!scheduler) return noScheduler;
    return { json: { tasks: await scheduler.list(scopeOwner(ctx)) } };
  });

  r.post("/scheduled-tasks", async (ctx) => {
    if (!scheduler) return noScheduler;
    const body = await ctx.body<{ title?: string; prompt?: string; cron?: string; timezone?: string; enabled?: boolean; conversation_id?: string | null }>();
    if (!body.title || !body.prompt || !body.cron) {
      return { status: 400, json: { error: "title, prompt, and cron are required" } };
    }
    const bad = await badTarget(scopeOwner(ctx), body.conversation_id);
    if (bad) return { status: 400, json: { error: bad } };
    try {
      const task = await scheduler.create(scopeOwner(ctx), {
        title: body.title, prompt: body.prompt, cron: body.cron, timezone: body.timezone, enabled: body.enabled,
        conversation_id: body.conversation_id || null,
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
    // Target is fixed, so ownership is checked only at creation.
    if ("conversation_id" in body) {
      return { status: 400, json: { error: "conversation_id cannot be changed; recreate the task" } };
    }
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

  // --- Personal skills (UI settings page) ---------------------------------------
  // Owner-scoped CRUD over the same rows the conversation-start path injects, so what
  // the user sees here is exactly what their next conversation gets. 501 without a store.
  const userSkills = deps.userSkills;
  const noSkillStore = { status: 501, json: { error: "personal skills not configured" } };
  // `user.id` is already "anonymous" with no identity ingress: one shared bucket, which is
  // the right answer for a single-user box and the same trust boundary as its conversations.
  const skillOwner = (ctx: { user: { id: string } }) => ctx.user.id;
  // camelCase, unlike the scheduler's snake_case passthrough: these rows are ours.
  const skillView = (s: UserSkill) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    body: s.body,
    enabled: s.enabled,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  });
  /** A rejected write is the user's typo, not a server fault, so it reads as 400 with the store's message. */
  const skillWrite = async (fn: () => Promise<JsonResult>): Promise<JsonResult> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof UserSkillError) return { status: 400, json: { error: e.message } };
      throw e;
    }
  };

  r.get("/user-skills", async (ctx) => {
    if (!userSkills) return noSkillStore;
    const skills = await userSkills.list(skillOwner(ctx));
    // The deployment's names travel with the list so the form can warn about a shadow
    // without a second round trip.
    return { json: { skills: skills.map(skillView), builtinNames: deps.builtinSkillNames?.() ?? [] } };
  });

  r.post("/user-skills", async (ctx) =>
    skillWrite(async () => {
      if (!userSkills) return noSkillStore;
      const body = await ctx.body<{ name?: string; description?: string; body?: string; enabled?: boolean }>();
      const created = await userSkills.create(skillOwner(ctx), {
        name: (body.name ?? "").trim(),
        description: (body.description ?? "").trim(),
        body: body.body ?? "",
        enabled: body.enabled,
      });
      return { status: 201, json: skillView(created) };
    }),
  );

  r.patch("/user-skills/:id", async (ctx) =>
    skillWrite(async () => {
      if (!userSkills) return noSkillStore;
      const body = await ctx.body<{ name?: string; description?: string; body?: string; enabled?: boolean }>();
      const updated = await userSkills.patch(skillOwner(ctx), ctx.params.id, {
        ...(body.name === undefined ? {} : { name: body.name.trim() }),
        ...(body.description === undefined ? {} : { description: body.description.trim() }),
        ...(body.body === undefined ? {} : { body: body.body }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      });
      // 404 rather than 403 for someone else's id: the scope is the whole answer here.
      return updated ? { json: skillView(updated) } : { status: 404, json: { error: "not found" } };
    }),
  );

  r.del("/user-skills/:id", async (ctx) => {
    if (!userSkills) return noSkillStore;
    const gone = await userSkills.remove(skillOwner(ctx), ctx.params.id);
    return gone ? { status: 204, json: null } : { status: 404, json: { error: "not found" } };
  });

  // --- Hooks (UI settings page) ---------------------------------------------------
  r.get("/user-hooks", async (ctx) => {
    const choices = deps.userHookSettings ? await deps.userHookSettings.list(skillOwner(ctx)) : new Map<string, boolean>();
    return {
      json: {
        configurable: deps.userHookSettings !== undefined,
        hooks: (deps.hooks ?? []).map((h) => ({
          id: h.id,
          event: h.event,
          description: h.description,
          userCanDisable: h.userCanDisable,
          enabled: !h.userCanDisable || (choices.get(h.id) ?? true),
        })),
      },
    };
  });

  r.patch("/user-hooks/:id", async (ctx) => {
    if (!deps.userHookSettings) return { status: 501, json: { error: "hook settings not configured" } };
    const hook = (deps.hooks ?? []).find((h) => h.id === ctx.params.id);
    if (!hook) return { status: 404, json: { error: "not found" } };
    if (!hook.userCanDisable) return { status: 403, json: { error: "this hook is required by the deployment" } };
    const body = await ctx.body<{ enabled?: unknown }>();
    if (typeof body.enabled !== "boolean") return { status: 400, json: { error: "enabled must be a boolean" } };
    await deps.userHookSettings.set(skillOwner(ctx), hook.id, body.enabled);
    return { json: { id: hook.id, enabled: body.enabled } };
  });

  // --- Contrib settings-tab API -------------------------------------------------
  // The broker keys a conversation by its short id.
  if (deps.contribApi) {
    mountContribApi(r, {
      conversationKey: async (id) => {
        const convId = await resolveConvId(id);
        return convId ? shortId(convId) : null;
      },
      ...deps.contribApi,
    });
  }

  return r;
}
