/**
 * Management API: the REST surface around the SessionManager (conversation CRUD,
 * lifecycle, history, approvals, sandbox services). The AG-UI streaming endpoint
 * (POST /agui) stays the assistant-ui transport; these routes sit next to it on
 * the same node:http server.
 */

import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createRouter, type JsonResult, type Router, type ResolveUser } from "../http/router.js";
import type { SessionManager, Conversation } from "../session/manager.js";
import type { ConversationStore, ChecksummedEvent, ConversationLink } from "../session/manager.js";
import { PLACEHOLDER_TITLE, prefixedPlaceholder, sandboxKey } from "../session/manager.js";
import type { SessionId } from "../types.js";
import { tailByRuns } from "../session/eventWindow.js";
import { trimToBoundary } from "../session/eventStore.js";
import { isUnansweredInterrupt } from "../session/danglingRun.js";
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
import { steeringAuthor, type AuthorStore, type ResolvedAuthor } from "../session/authorStore.js";
import { describeAuthor, describeTaint, parseShown, shownRows, taintingAuthors } from "../session/taint.js";
import { SubagentLimitError, type SubagentManager } from "../agent/subagentTools.js";
import type { IdentityRegistry } from "../session/identityRegistry.js";
import { targetError, type ConversationOwnerLookup, type SchedulerClient } from "../agent/schedulerTools.js";
import { mountContribApi, type ContribApiDeps } from "./contribApi.js";
import { UserSkillError, type UserSkill, type UserSkillStore } from "../session/userSkillStore.js";
import type { SandboxResources } from "../session/resources.js";
import { fitAdvice, fitSummary } from "../session/resourceFit.js";
import type { SandboxSizePreset } from "../session/resources.js";
import type { WorkspaceVolume } from "../session/workspaceVolume.js";
import { PRIORITY_INTERRUPT, userAssertionOf, type AguiEvent, type ApproverIdentity, type SessionBridge } from "../bridge.js";
import { formatError, logger } from "../log.js";
import type { AccessCheck } from "../session/access.js";
import { isVisibility } from "../session/visibility.js";
import { serviceUrl, type SandboxOrigins } from "../proxy/sandboxOrigin.js";
import { createStateHub, sandboxWatcher, type StateHub } from "../session/stateHub.js";
import { mountStateStream } from "./stateStream.js";
import { EMPTY_CHECKSUM, chainAll } from "../agui/integrity.js";
import { DERIVED_SOURCES, HUMAN_TRIGGER_SOURCES, USER_RELAY_SOURCES } from "../acp/remoteAgentRegistry.js";
import type { HookDef } from "../hooks/types.js";
import type { UserHookSettingsStore } from "../hooks/userHookSettingsStore.js";
import { BUILTIN_THEME_ID, isThemeId, loadDefaultThemeId, loadThemes } from "../theme/themes.js";
import { isThemeMode, type UserTheme, type UserThemeStore } from "../theme/userThemeStore.js";
import { isLifetimeHours, type UserRetentionStore } from "../retention/userRetentionStore.js";

const log = logger("agent-host");

/** True when `p` is absolute and stays under /workspace after normalizing `..`. */
export function isWorkspacePath(p: string): boolean {
  return p.startsWith("/") && (posix.normalize(p) + "/").startsWith("/workspace/");
}
const remoteAgentLog = logger("remote-agent");

/** Sources POST /messages refuses, so a sandbox cannot pose as human. */
const RESERVED_SOURCES: ReadonlySet<string> = new Set(
  [...HUMAN_TRIGGER_SOURCES, ...DERIVED_SOURCES].filter((s) => !USER_RELAY_SOURCES.has(s)),
);

/** Set by the router's sandbox self-access listener. */
const SANDBOX_CALLER_HEADER = "x-scooter-caller";
/** The source given to a sandbox's message that names none. */
export const SANDBOX_SOURCE = "sandbox";

/** Longest gap a resume sends before resetting instead. */
export const RESUME_MAX_EVENTS = 2000;

/** The integrity request's resume cursor, if well-formed. */
export function resumeCursor(query: URLSearchParams): { afterSeq: number; checksum: string } | undefined {
  const afterSeq = Number(query.get("afterSeq"));
  const checksum = query.get("checksum") ?? "";
  if (!Number.isInteger(afterSeq) || afterSeq < 1 || !/^[0-9a-f]{64}$/.test(checksum)) return undefined;
  return { afterSeq, checksum };
}

/** Whether `events` follow `anchor` with no gap: consecutive seqs, each chaining on the last. */
export function chainsFrom(anchor: { seq: number; checksum: string }, events: ChecksummedEvent[]): boolean {
  let at = anchor;
  for (const c of events) {
    if (c.seq !== at.seq + 1 || c.prevChecksum !== at.checksum) return false;
    at = { seq: c.seq, checksum: c.checksum };
  }
  return true;
}

/** The inclusive [start, end] of a single `bytes=` range within `size`, or null if unsatisfiable. */
export function parseByteRange(header: string, size: number): [number, number] | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "") || size === 0) return null;
  if (m[1] === "") {
    // A suffix range: the last N bytes.
    const n = Number(m[2]);
    return n > 0 ? [Math.max(0, size - n), size - 1] : null;
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start <= end ? [start, end] : null;
}

/** A source, titlePrefix or origin: a short lowercase name. */
const LOWERCASE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/** Whether a POST /messages caller may tag its message with this system source. */
export function isPostableSource(source: unknown): source is string {
  return typeof source === "string" && LOWERCASE_NAME.test(source) && !RESERVED_SOURCES.has(source);
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
    // "session" when a person drives this child.
    kind: c.kind,
    // Where a session was started from, e.g. "vscode" or "web".
    origin: c.origin,
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
  /** Answer a pending interrupt as `approver`, the same path as an /agui resume. */
  answerInterrupt: Parameters<AguiServer["onResume"]>[0];
  /** Relay the user's answer (the optionId is the verb) to the contrib's broker half as `approver`; throws on a dropped answer. */
  resolveApproval?: (
    sessionId: string,
    contrib: string,
    requestId: string,
    optionId: string,
    approver: ApproverIdentity,
  ) => Promise<void>;
  /** Whether `approver` (the viewing user) may act on this request, and whether it is still pending; fails closed broker-side and defaults to allowed when unwired. */
  canApproveRequest?: (
    sessionId: string,
    contrib: string,
    requestId: string,
    approver: ApproverIdentity,
  ) => Promise<{ canApprove: boolean; pending?: boolean }>;
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
  /** The sandbox-MCP proxy, per server name; absent without a sandbox or token secret. */
  sandboxMcpHandler?: (req: IncomingMessage, res: ServerResponse, body: unknown, name: string) => Promise<void>;
  /** Upload caps served to the UI in /whoami's `limits` block (scooter.uploads). */
  uploadLimits?: { maxFileBytes: number; maxFilesPerMessage: number };
  /** Unfiled conversations' idle lifetime in hours, 0 forever; for /whoami. */
  defaultLifetimeHours?: number;
  /** Per-user overrides of that default; absent hides the setting. */
  userRetention?: UserRetentionStore;
  /** Resolves the caller's identity per request; defaults to the env-configured resolver. */
  resolveUser?: ResolveUser;
  /** Whether a request is a trusted in-cluster caller (webhooks/scheduler) allowed to set a body `owner`; absent means a body owner is never honored. */
  ownerVerifier?: (req: IncomingMessage) => Promise<boolean>;
  /** Whether a request is a platform service; checked under authEnforced. */
  serviceCaller?: (req: IncomingMessage) => Promise<boolean>;
  /** The visibility check guarding every /conversations/:id route; absent means no guard (tests). */
  accessCheck?: AccessCheck;
  /** AUTH_ENFORCE: the router proves every user, so anonymous is never the single user. */
  authEnforced?: boolean;
  /** In-pod web-service registry powering the UI Services panel; absent in fake/local mode. */
  webServices?: WebServiceRegistry;
  /** Whether a running conversation's sandbox is ready; defaults to webServices, else never. */
  sandboxReady?: (id: string) => Promise<boolean>;
  /** Per-conversation service origins (SANDBOX_DOMAIN); absent keeps services under /c/<id>/. */
  sandboxOrigins?: SandboxOrigins;
  /** Who wrote each conversation's text, served to the broker; absent omits `authors`, which it reads as tainted. */
  authorStore?: AuthorStore;
  /** Spawns sessions within subagent limits; absent, sessions routes 501. */
  subagents?: SubagentManager;
  /** Forge accounts and the users who linked them. */
  identityRegistry?: IdentityRegistry;
  /** Whether a request is the broker, who alone may link accounts. */
  brokerCaller?: (req: IncomingMessage) => Promise<boolean>;
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
  /** The scooter.ui.themes mount; absent means only the built-in. */
  themesDir?: string;
  /** Per-user theme choices; absent leaves it to each browser. */
  userThemes?: UserThemeStore;
  /** The /contrib-api relay for contrib settings tabs; absent means the routes are not mounted. */
  contribApi?: ContribApiDeps;
  /** Absent builds one with the built-in `sandbox` watcher. */
  stateHub?: StateHub;
  /** The deployment skills' names, so the settings form can warn that a personal skill of the same name replaces one. */
  builtinSkillNames?: () => string[];
  /** Summarize older turns and continue on summary+recent; null when too short to compact, throws on summarizer failure. */
  compact?: (conversationId: string) => Promise<{ summarizedTurns: number; keptRuns: number } | null>;
  /** The conversation's current sandbox resource requests/limits; wired only on the broker path. */
  sandboxResources?: (conversationId: string) => Promise<SandboxResources | undefined>;
  /** The /workspace claim's size; absent without k8s. */
  workspaceVolume?: (conversationId: string) => Promise<WorkspaceVolume | undefined>;
  /** The named sandbox size presets and the default preset name; wired only on the broker path. */
  sandboxSizes?: () => Promise<{ sizes: Record<string, SandboxSizePreset>; default: string | null }>;
  /** Record a named size preset for a conversation, rejecting unknown names; absent means the route reports 501. */
  setSandboxSize?: (conversationId: string, size: string) => Promise<void>;
  /** Write a base64 file into the sandbox at `dir`/<name>; absent in fake mode. */
  writeSandboxFile?: (conversationId: string, file: { dir: string; name: string; data: string }) => Promise<string>;
  /** Read a sandbox file as base64; absent in fake mode. */
  readSandboxFile?: (conversationId: string, path: string) => Promise<{ data: string } | { error: string }>;
  /** Bring-your-own-Claude support for the Settings "Connect your Claude agent" section; absent when REMOTE_AGENT_JOIN_SECRET is unset, so the UI hides it. */
  remoteAgent?: {
    /** Mint a fresh owner-bound join token plus the docker one-liner; async because the session is minted on the controller. */
    mint(owner: string): Promise<{ token: string; dockerCommand: string; wsUrl: string }>;
    /** Whether the owner's agent is connected, plus their most recent rejected connection attempt. */
    status(owner: string): Promise<{ connected: boolean; lastAuthFailure: { reason: string; at: string } | null }>;
    /** Whether this owner's remote agent is connected right now (durable via the DB when one is wired). */
    isConnected(owner: string): Promise<boolean>;
    /** The owner's registered devices; null when device auth is off. */
    listDevices?(owner: string): Promise<{ id: string; label?: string; lastSeen: number }[] | null>;
    /** Revoke one of the owner's devices. */
    deregisterDevice?(owner: string, deviceId: string): Promise<void>;
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

/** The contrib-rendered `agent_message` in a verb's answer, which the agent is prompted with. */
export function approvalAgentMessage(body: string): string | undefined {
  try {
    const msg = (JSON.parse(body) as { agent_message?: unknown } | null)?.agent_message;
    return typeof msg === "string" && msg.trim() ? msg : undefined;
  } catch {
    return undefined;
  }
}

/** A conversation's pending broker approvals under one key; [] on error. */
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

/** Pending approvals under any of these keys, deduplicated by request. */
export async function fetchPendingApprovalsByKeys(
  brokerUrl: string,
  pendingPath: string,
  keys: string[],
  authHeaders: Record<string, string>,
  onWarn?: (status: number) => void,
): Promise<ApprovalRequest[]> {
  const byId = new Map<string, ApprovalRequest>();
  for (const key of new Set(keys)) {
    for (const req of await fetchPendingApprovals(brokerUrl, pendingPath, key, authHeaders, onWarn)) {
      if (!byId.has(req.request_id)) byId.set(req.request_id, req);
    }
  }
  return [...byId.values()];
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

  /** Settle an approval card nobody can answer any more, in the log and live; false if already settled. */
  const withdrawApproval = async (id: SessionId, requestId: string): Promise<boolean> => {
    const resolved: AguiEvent = { type: "PERMISSION_RESOLVED", toolCallId: requestId, optionId: null };
    // A live bridge persists the event itself; otherwise append it to the log.
    if (!sessions.get(id)?.bridge?.withdrawInterrupt(requestId)) {
      const events: AguiEvent[] = [];
      for await (const e of store.readEvents(id)) events.push(e);
      if (!isUnansweredInterrupt(events, requestId)) return false;
      await store.appendEvent(id, resolved);
    }
    // Persisting does not broadcast, so open panels drop the card here.
    server.broadcast(id, resolved);
    return true;
  };

  const sandboxReady =
    deps.sandboxReady ?? (deps.webServices ? (id: string) => deps.webServices!.ready(id) : async () => false);

  // Probes start only once a tab subscribes.
  const stateHub =
    deps.stateHub ??
    createStateHub([
      sandboxWatcher({
        status: async (id) => sessions.get(id)?.status ?? "unknown",
        ready: async (id) => {
          // Refreshing may find the pod gone; the next tick reports it.
          await sessions.refreshSandbox?.(id as SessionId);
          return sandboxReady(id);
        },
        services: (id) => listWebServices(id),
      }),
    ]);

  // Every /conversations/:id route answers 404 for a private conversation the caller may not
  // see: the same answer as a missing one, so its existence does not leak.
  if (deps.accessCheck) {
    const check = deps.accessCheck;
    r.guard(async (ctx) => {
      const id = ctx.params.id;
      if (!id || !(ctx.req.url ?? "").startsWith("/conversations/")) return undefined;
      try {
        let verdict = await check(id, ctx.req, ctx.user);
        // The broker addresses conversations by their sandbox key.
        if (verdict === "unknown") {
          const conv = await sessions.getBySandboxKey(id);
          if (conv) verdict = await check(conv.id, ctx.req, ctx.user);
        }
        return verdict === "deny" ? { status: 404, json: { error: "not found" } } : undefined;
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

  // MCP servers declared in the conversation's own pod.
  if (deps.sandboxMcpHandler) {
    const proxy = deps.sandboxMcpHandler;
    const route = async (ctx: { req: IncomingMessage; res: ServerResponse; params: Record<string, string>; body: <T>() => Promise<T> }) => {
      const body = ctx.req.method === "POST" ? await ctx.body<unknown>().catch(() => undefined) : undefined;
      await proxy(ctx.req, ctx.res, body, ctx.params.name);
    };
    r.post("/sandbox-mcp/:name", route as never);
    r.get("/sandbox-mcp/:name", route as never);
    // MCP clients end a session with DELETE.
    r.del("/sandbox-mcp/:name", route as never);
  }

  /** The caller's own default lifetime; a failed read falls back to the deployment's. */
  const userLifetime = async (user: { id: string; anonymous: boolean }): Promise<number | undefined> => {
    if (!deps.userRetention || user.anonymous) return undefined;
    try {
      return await deps.userRetention.get(user.id);
    } catch (err) {
      log.warn("user retention read failed; using the deployment default", { error: (err as Error).message });
      return undefined;
    }
  };

  // The caller per the trusted ingress identity header (anonymous when none).
  r.get("/whoami", async (ctx) => {
    const own = await userLifetime(ctx.user);
    const lifetime = own ?? deps.defaultLifetimeHours;
    return {
      json: {
        id: ctx.user.id,
        email: ctx.user.email ?? null,
        anonymous: ctx.user.anonymous,
        ...(deps.uploadLimits ? { limits: { ...deps.uploadLimits } } : {}),
        ...(lifetime !== undefined ? { retention: { defaultLifetimeHours: lifetime } } : {}),
      },
    };
  });

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

  // Settings device list, relayed to the controller's internal port.
  r.get("/remote-agent/devices", async (ctx) => {
    const ra = deps.remoteAgent;
    if (!ra?.listDevices) return { status: 404, json: { error: "device auth not enabled" } };
    if (ctx.user.anonymous) return { status: 401, json: { error: "authentication required" } };
    try {
      const devices = await ra.listDevices(ctx.user.id);
      return devices ? { json: devices } : { status: 404, json: { error: "device auth not enabled" } };
    } catch (err) {
      remoteAgentLog.errorWith("device list failed", err, { user_id: ctx.user.id });
      return { status: 503, json: { error: "The BYOC controller is unreachable." } };
    }
  });

  r.del("/remote-agent/devices/:id", async (ctx) => {
    const ra = deps.remoteAgent;
    if (!ra?.deregisterDevice) return { status: 404, json: { error: "device auth not enabled" } };
    if (ctx.user.anonymous) return { status: 401, json: { error: "authentication required" } };
    try {
      await ra.deregisterDevice(ctx.user.id, ctx.params.id);
      return { status: 204, json: null };
    } catch (err) {
      remoteAgentLog.errorWith("device deregister failed", err, { user_id: ctx.user.id });
      return { status: 503, json: { error: "The BYOC controller is unreachable." } };
    }
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
    // The broker's OwnerResolver asks by the sandbox key.
    conv ??= await sessions.getBySandboxKey(ctx.params.id);
    if (!conv) return { status: 404, json: { error: "not found" } };
    // Star, title and visibility may be written elsewhere; serve the durable values.
    await sessions.refreshRouterMeta(conv.id).catch(() => {});
    // A failed read omits `authors`, so the broker withholds credentials.
    const authors = await deps.authorStore?.listTree(conv.id).catch((e: unknown) => {
      log.warn("could not read conversation authors", { conversation_id: conv!.id, error: formatError(e) });
      return undefined;
    });
    return { json: { ...view(sessions.get(conv.id) ?? conv), ...(authors ? { authors } : {}) } };
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

  /** Records a non-owner reaching in; throws when it can't. */
  const recordSteering = async (id: string, req: IncomingMessage, user: { anonymous: boolean; id: string }) => {
    // A platform service's notice is not anyone steering it.
    if (user.anonymous && deps.serviceCaller && (await deps.serviceCaller(req).catch(() => false))) return;
    if (!sessions.get(id)) await sessions.ensureReadable(id);
    const author = steeringAuthor(user, sessions.get(id)?.owner);
    if (author) await deps.authorStore?.record(id, author);
  };

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

  /** The owner's view of who taints the tree; 403 for anyone else. */
  const taintFor = async (id: string, user: { anonymous: boolean; id: string }) => {
    if (!sessions.get(id)) await sessions.ensureReadable(id);
    const conv = sessions.get(id);
    if (!conv) return { status: 404 as const, error: "not found" };
    if (user.anonymous || !conv.owner || conv.owner !== user.id) {
      return { status: 403 as const, error: "only the owner can see or clear the taint" };
    }
    if (!deps.authorStore) return { status: 501 as const, error: "authors are not recorded here" };
    const visibility = (await store.readAccess?.(conv.id))?.visibility ?? conv.visibility ?? "shared";
    const authors = taintingAuthors(await deps.authorStore.listTree(conv.id), conv.owner);
    return { conv, visibility, authors, owner: conv.owner };
  };
  const taintView = (visibility: string, authors: ResolvedAuthor[]) => ({
    visibility,
    summary: authors.length ? describeTaint(authors) : "",
    authors: authors.map((a) => ({ conversationId: a.conversationId, kind: a.kind, author: a.author, lastAt: a.lastAt, label: describeAuthor(a) })),
  });

  // Non-owner authors keep the tree from acting as its owner.
  r.get("/conversations/:id/taint", async (ctx) => {
    const t = await taintFor(ctx.params.id, ctx.user);
    if ("error" in t) return { status: t.status, json: { error: t.error } };
    return { json: taintView(t.visibility, t.authors) };
  });

  // Clears only what the owner was shown; newer text still taints.
  r.post("/conversations/:id/taint/clear", async (ctx) => {
    const t = await taintFor(ctx.params.id, ctx.user);
    if ("error" in t) return { status: t.status, json: { error: t.error } };
    // Shared, anyone may still prompt it, so a clear would not last.
    if (t.visibility !== "private") return { status: 409, json: { error: "make the conversation private before clearing its taint" } };
    const shown = parseShown((await ctx.body<{ authors?: unknown }>()).authors);
    if (!shown) return { status: 400, json: { error: "authors must be the rows GET /taint returned" } };
    const cleared = await deps.authorStore!.clear(shownRows(shown, t.authors), { user: t.owner, via: "ui" });
    const left = taintingAuthors(await deps.authorStore!.listTree(t.conv.id), t.owner);
    log.info("owner cleared a conversation's taint", { conversation_id: t.conv.id, cleared, left: left.length });
    return { json: { cleared, ...taintView(t.visibility, left) } };
  });

  r.post("/conversations/:id/suspend", async (ctx) => {
    // Hydrate-if-absent so suspend reaches the conversation whichever replica answers.
    if (!sessions.get(ctx.params.id) && (await sessions.ensureReadable(ctx.params.id))) {
      /* hydrated into memory */
    }
    if (!sessions.get(ctx.params.id)) return { status: 404, json: { error: "not found" } };
    await sessions.suspend(ctx.params.id);
    stateHub.nudge(ctx.params.id);
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
      stateHub.nudge(conv!.id);
      return { json: result };
    } catch (e) {
      if ((e as { code?: number }).code === 409) return { status: 409, json: { error: (e as Error).message } };
      throw e;
    }
  });

  r.post("/conversations/:id/resume", async (ctx) => {
    if (!sessions.get(ctx.params.id)) return { status: 404, json: { error: "not found" } };
    await sessions.revive(ctx.params.id);
    stateHub.nudge(ctx.params.id);
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
    await recordSteering(ctx.params.id, ctx.req, ctx.user);
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

  // Idle children a pod service, such as VS Code, drives.
  r.post("/conversations/:id/sessions", async (ctx) => {
    if (!deps.subagents) return { status: 501, json: { error: "sessions unavailable" } };
    const body = await ctx.body<{ title?: unknown; titlePrefix?: unknown; origin?: unknown; model?: unknown }>();
    if (body.title !== undefined && typeof body.title !== "string") {
      return { status: 400, json: { error: "title must be a string" } };
    }
    if (body.titlePrefix !== undefined && !(typeof body.titlePrefix === "string" && LOWERCASE_NAME.test(body.titlePrefix))) {
      return { status: 400, json: { error: "titlePrefix must be a lowercase name" } };
    }
    if (body.origin !== undefined && !(typeof body.origin === "string" && LOWERCASE_NAME.test(body.origin))) {
      return { status: 400, json: { error: "origin must be a lowercase name" } };
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      return { status: 400, json: { error: "model must be a string" } };
    }
    if (body.model && body.model !== models.default && !models.available.includes(body.model)) {
      return { status: 400, json: { error: `unknown model: ${body.model}` } };
    }
    const { conv, error } = mutableFor(ctx.params.id, ctx.user);
    if (error === 404) return { status: 404, json: { error: "not found" } };
    if (error === 403) return { status: 403, json: { error: "not your conversation" } };
    if (conv!.parentId) return { status: 400, json: { error: "a session's parent must be a top-level conversation" } };
    if (conv!.status !== "running") return { status: 409, json: { error: "the sandbox is not running; resume the conversation first" } };
    // A prefixed title already names its origin, as VS Code's does.
    const origin = (body.origin ?? body.titlePrefix) as string | undefined;
    try {
      const child = await deps.subagents.spawn(conv!.id as SessionId, {
        kind: "session",
        // A placeholder title, so the router's row does not read "Subagent".
        title: (body.title as string | undefined) || (body.titlePrefix ? prefixedPlaceholder(body.titlePrefix as string) : PLACEHOLDER_TITLE),
        ...(origin ? { origin } : {}),
        ...(body.model ? { model: body.model } : {}),
      });
      stateHub.nudge(conv!.id);
      return { status: 201, json: { id: child.id, title: child.title } };
    } catch (e) {
      if (e instanceof SubagentLimitError) {
        return { status: 429, json: { error: "too many running children; retry after one finishes" } };
      }
      throw e;
    }
  });

  r.get("/conversations/:id/sessions", async (ctx) => {
    if (!sessions.get(ctx.params.id)) return { status: 404, json: { error: "not found" } };
    const children = sessions
      .list()
      .filter((c) => c.parentId === ctx.params.id && c.kind === "session")
      .sort((a, b) => a.createdAt - b.createdAt);
    return { json: { sessions: children.map((c) => ({ id: c.id, title: c.title, status: c.status })) } };
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
    const size = asset.data.length;
    // The assetId is content-addressed, so the bytes never change.
    const headers = { "Content-Type": asset.mimeType, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=31536000, immutable" };
    const header = ctx.req.headers.range;
    if (header === undefined) {
      res.writeHead(200, { ...headers, "Content-Length": String(size) }).end(asset.data);
      return;
    }
    // Video players seek with Range requests; Safari will not play without them.
    const range = parseByteRange(header, size);
    if (!range) {
      res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` }).end();
      return;
    }
    const [start, end] = range;
    res
      .writeHead(206, { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${size}` })
      .end(asset.data.subarray(start, end + 1));
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
    // Reported on `synced` as the client's resume cursor.
    let head: { seq: number; checksum: string } | undefined;
    const note = (c: ChecksummedEvent) => {
      seen.add(c.checksum);
      if (c.seq !== undefined && (!head || c.seq > head.seq)) head = { seq: c.seq, checksum: c.checksum };
    };
    let live = false;
    const buffer: ChecksummedEvent[] = [];
    const unsub = store.onAppend?.((evId, c) => {
      if (evId !== id) return;
      if (!live) buffer.push(c);
      else if (!seen.has(c.checksum)) {
        note(c);
        send({ kind: "event", ...c });
      }
    });

    // Flush pending fire-and-forget appends before replaying, so a just-sent message still
    // mid-write lands in the replay or the pre-live buffer rather than neither.
    await store.flush?.(id);

    const cursor = resumeCursor(ctx.query);
    const resumed = cursor && store.readEventsAfter
      ? await store.readEventsAfter(id, cursor.afterSeq, RESUME_MAX_EVENTS)
      : undefined;
    if (
      cursor &&
      resumed &&
      resumed.anchor === cursor.checksum &&
      !resumed.more &&
      chainsFrom({ seq: cursor.afterSeq, checksum: cursor.checksum }, resumed.events)
    ) {
      // Cursor matches the log and the slice is gapless: send only what follows.
      send({ kind: "resume" });
      head = { seq: cursor.afterSeq, checksum: cursor.checksum };
      for (const c of resumed.events) {
        note(c);
        send({ kind: "event", ...c });
      }
    } else if (store.readEventsWithChecksum) {
      // The client must drop its cached fold.
      if (cursor) send({ kind: "reset" });
      // History goes as one snapshot rather than N events, since the client's applier
      // rebuilds and clones the message list per event; events carrying no message state
      // still replay individually.
      const history: AguiEvent[] = [];
      for await (const c of store.readEventsWithChecksum(id)) {
        note(c);
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
        note(c);
        send({ kind: "event", ...c });
      }
    }
    live = true;
    // Mark the end of the initial replay so the client knows it is caught up.
    send({ kind: "synced", ...(head ? { seq: head.seq, checksum: head.checksum } : {}) });
    // State topics share this connection; browsers cap HTTP/1.1 connections per host.
    const unsubState = stateHub.subscribe(id, (f) => {
      if (f.kind === "topic") send(f);
    });

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
      unsubState();
    });
  });

  r.post("/conversations/:id/permission/:toolCallId", async (ctx) => {
    const body = await ctx.body<{ optionId?: string }>();
    if (!body.optionId) return { status: 400, json: { error: "optionId required" } };
    // The broker authorizes the answering user, not the conversation owner; anonymous
    // means no identity claims.
    const approver = ctx.user.anonymous
      ? undefined
      : { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, assertion: userAssertionOf(ctx.req) };
    const outcome = await deps.answerInterrupt(
      ctx.params.id as SessionId,
      { interruptId: ctx.params.toolCallId, status: "resolved", payload: { optionId: body.optionId } },
      approver,
    );
    if (!outcome.ok) return { status: 409, json: { error: outcome.reason ?? "no longer awaiting an answer" } };
    return { status: 204, json: null };
  });

  // The webhooks service answers for a chat user it mapped to a Scooter user (a Slack button),
  // so only that verified caller may name the answerer, and only the owner may answer.
  r.post("/conversations/:id/interrupts/:interruptId/answer", async (ctx) => {
    if (!deps.conversationOwner) return { status: 501, json: { error: "answering is not wired" } };
    if (!deps.ownerVerifier || !(await deps.ownerVerifier(ctx.req).catch(() => false))) {
      return { status: 403, json: { error: "only the webhooks service answers for another user" } };
    }
    const body = await ctx.body<{ answeredBy?: { id?: unknown; email?: unknown }; optionId?: unknown; result?: unknown }>();
    const by = body.answeredBy;
    if (typeof by?.id !== "string" || !by.id || typeof body.optionId !== "string" || !body.optionId) {
      return { status: 400, json: { error: "answeredBy.id and optionId required" } };
    }
    const id = (await resolveConvId(ctx.params.id)) ?? ctx.params.id;
    const owner = (await deps.conversationOwner(id))?.owner;
    if (!owner || owner !== by.id) {
      return { status: 403, json: { error: "only the conversation's owner can answer" } };
    }
    const approver: ApproverIdentity = {
      id: by.id,
      ...(typeof by.email === "string" ? { email: by.email } : {}),
      assertion: userAssertionOf(ctx.req),
    };
    const payload = { optionId: body.optionId, ...(body.result !== undefined ? { result: body.result } : {}) };
    const outcome = await deps.answerInterrupt(
      id as SessionId,
      { interruptId: ctx.params.interruptId, status: "resolved", payload },
      approver,
    );
    if (!outcome.ok) return { status: 409, json: { error: outcome.reason ?? "no longer awaiting an answer" } };
    return { json: { answered: true } };
  });

  // Whether the current viewer may act on this request, per viewer since one interrupt is
  // seen by many users; anonymous users can never approve.
  r.get("/conversations/:id/approvals/:contrib/:requestId/can-approve", async (ctx) => {
    if (!deps.canApproveRequest) return { json: { canApprove: true } }; // unwired → don't block
    if (ctx.user.anonymous) return { json: { canApprove: false } };
    const approver = { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name, assertion: userAssertionOf(ctx.req) };
    const answer: { canApprove: boolean; pending?: boolean } = await deps
      .canApproveRequest(ctx.params.id, ctx.params.contrib, ctx.params.requestId, approver)
      .catch(() => ({ canApprove: false })); // fail closed (greyed) on any error
    // A request the contrib no longer has cannot be answered, so its card goes for everyone.
    if (answer.pending === false) {
      const conv = sessions.get(ctx.params.id) ?? (await sessions.getBySandboxKey(ctx.params.id));
      if (conv) {
        await withdrawApproval(conv.id as SessionId, ctx.params.requestId).catch((err) =>
          log.warn("withdrawing a stale approval failed", { conversation_id: conv.id, error: formatError(err) }),
        );
      }
    }
    return { json: answer };
  });

  // External resource links (the GitHub PR / Slack thread a conversation came from): the
  // webhooks service POSTs them on create and the UI GETs them.

  // Links, approval cards and the resource map are service-only.
  const fromService = async (req: IncomingMessage): Promise<boolean> => {
    if (!deps.authEnforced) return true;
    return deps.serviceCaller ? deps.serviceCaller(req).catch(() => false) : false;
  };
  const serviceOnly = { status: 403, json: { error: "only a platform service may call this" } };

  // Accepts a conversation id or the broker's sandbox key.
  const resolveConvId = async (id: string): Promise<string | null> => {
    const conv = sessions.get(id) ?? (await sessions.getBySandboxKey(id));
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
    if (!(await fromService(ctx.req))) return serviceOnly;
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

  // A linked forge account's messages count as its user's own.
  const fromBroker = async (req: IncomingMessage): Promise<boolean> => {
    if (!deps.authEnforced) return true;
    return deps.brokerCaller ? deps.brokerCaller(req).catch(() => false) : false;
  };
  const LINKABLE = new Set(["github", "gitlab"]);
  r.on("PUT", "/identity-links/:provider/:user", async (ctx) => {
    if (!(await fromBroker(ctx.req))) return { status: 403, json: { error: "only the broker may link accounts" } };
    if (!deps.identityRegistry) return { status: 503, json: { error: "no identity registry" } };
    const { provider, user } = ctx.params;
    const body = await ctx.body<{ externalId?: unknown; handle?: unknown }>();
    if (!LINKABLE.has(provider) || !user) return { status: 400, json: { error: "unknown provider" } };
    if (typeof body.externalId !== "string" || !body.externalId || typeof body.handle !== "string") {
      return { status: 400, json: { error: "externalId and handle required" } };
    }
    await deps.identityRegistry.link({ provider, externalId: body.externalId, handle: body.handle }, user);
    log.info("forge account linked", { provider, user, external_id: body.externalId });
    return { status: 204, json: null };
  });
  r.del("/identity-links/:provider/:user", async (ctx) => {
    if (!(await fromBroker(ctx.req))) return { status: 403, json: { error: "only the broker may link accounts" } };
    if (!deps.identityRegistry) return { status: 503, json: { error: "no identity registry" } };
    const { provider, user } = ctx.params;
    if (!LINKABLE.has(provider) || !user) return { status: 400, json: { error: "unknown provider" } };
    await deps.identityRegistry.unlink(provider, user);
    log.info("forge account unlinked", { provider, user });
    return { status: 204, json: null };
  });

  r.get("/conversations/:id/links", async (ctx) => {
    const id = (await resolveConvId(ctx.params.id)) ?? ctx.params.id;
    const links = (await store.listLinks?.(id)) ?? [];
    return { json: { links } };
  });

  r.post("/conversations/:id/links", async (ctx) => {
    if (!(await fromService(ctx.req))) return serviceOnly;
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
    const clash = await store.addLink?.(id, {
      source: body.source,
      resourceType: body.resourceType,
      url: body.url,
      title: body.title,
      ref: body.ref,
    });
    if (clash) {
      return {
        status: 409,
        json: { error: "resource is linked to another conversation", conversationId: clash.ownerConversationId },
      };
    }
    return { status: 201, json: { ok: true } };
  });

  // Contribs run outside the sandbox, so file I/O for them goes through here.
  r.post("/conversations/:id/files", async (ctx) => {
    if (!deps.writeSandboxFile) return { status: 501, json: { error: "sandbox file writes unavailable" } };
    const id = await resolveLiveConvId(ctx.params.id);
    if (!id) return { status: 404, json: { error: "not found" } };
    const body = await ctx.body<{ dir?: string; name?: string; data?: string }>();
    if (!body.dir || !body.name || !body.data) {
      return { status: 400, json: { error: "dir, name and data required" } };
    }
    if (!isWorkspacePath(body.dir)) return { status: 400, json: { error: "dir must be under /workspace" } };
    await recordSteering(id, ctx.req, ctx.user);
    const path = await deps.writeSandboxFile(id, { dir: body.dir, name: body.name, data: body.data });
    return { status: 201, json: { path } };
  });

  r.get("/conversations/:id/files", async (ctx) => {
    if (!deps.readSandboxFile) return { status: 501, json: { error: "sandbox file reads unavailable" } };
    const id = await resolveLiveConvId(ctx.params.id);
    if (!id) return { status: 404, json: { error: "not found" } };
    const path = ctx.query.get("path");
    if (!path) return { status: 400, json: { error: "path required" } };
    if (!isWorkspacePath(path)) return { status: 400, json: { error: "path must be under /workspace" } };
    const result = await deps.readSandboxFile(id, path);
    if ("error" in result) return { status: 404, json: { error: result.error } };
    return { json: { data: result.data } };
  });

  // Web services (marimo/xterm/vscode) declared in the sandbox and reverse-proxied at
  // /c/<id>/<name>/; the UI Services panel lists and starts them.

  // Actual pod readiness: `status` can be "running" while the pod is still
  // ContainerCreating, and exec succeeds only once the pod is Ready.
  r.get("/conversations/:id/ready", async (ctx) => {
    const id = await resolveLiveConvId(ctx.params.id);
    const conv = id ? sessions.get(id) : undefined;
    // Only a running-status conversation can be ready.
    if (!id || !conv || conv.status !== "running") {
      return { json: { ready: false, status: conv?.status ?? "unknown" } };
    }
    const ready = await sandboxReady(id).catch(() => false);
    return { json: { ready, status: conv.status } };
  });

  mountStateStream(r, {
    hub: stateHub,
    resolve: async (id) => {
      if (!sessions.get(id) && !(await sessions.getBySandboxKey(id))) await sessions.ensureReadable(id);
      return resolveConvId(id);
    },
    fromService,
  });

  // Shared by GET /web-services and the `sandbox` topic.
  const listWebServices = async (id: string, force = false) => {
    if (!deps.webServices) return [];
    // An unlisted service is a backend another one frames (marimo's server); it stays proxied.
    const services = (await deps.webServices.list(id, { force })).filter((s) => s.visibleInMenu !== false);
    // One size read for the whole list; absent (fake mode / no broker) leaves every `fit`
    // undefined, which the UI renders as no warning.
    const size = deps.sandboxResources ? await deps.sandboxResources(id).catch(() => undefined) : undefined;
    return Promise.all(
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
  };

  r.get("/conversations/:id/web-services", async (ctx) => {
    const id = await resolveLiveConvId(ctx.params.id);
    if (!id || !deps.webServices) return { json: { services: [] } };
    // ?refresh=1 re-reads the in-pod manifest, since nothing in the pod signals a `scooter-rebuild`.
    const force = ctx.query.get("refresh") === "1";
    const services = await listWebServices(id, force);
    // A forced re-read may find services watchers have not seen.
    if (force) stateHub.nudge(id);
    return { json: { services } };
  });

  // The sandbox's current resource allotment for the Sandbox tab; an absent getter yields
  // {resources: null}.
  r.get("/conversations/:id/resources", async (ctx) => {
    const id = await resolveConvId(ctx.params.id);
    if (!id) return { json: { resources: null, pendingRestart: null, workspace: null } };
    // What a restart would pick up; best-effort.
    const [resources, pendingRestart, workspace] = await Promise.all([
      deps.sandboxResources ? deps.sandboxResources(id).catch(() => undefined) : undefined,
      sessions.get(id) && sessions.pendingRestart ? sessions.pendingRestart(id as SessionId).catch(() => undefined) : undefined,
      deps.workspaceVolume ? deps.workspaceVolume(id).catch(() => undefined) : undefined,
    ]);
    return { json: { resources: resources ?? null, pendingRestart: pendingRestart ?? null, workspace: workspace ?? null } };
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
    stateHub.nudge(id);
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
    stateHub.nudge(id);
    return { status: 202, json: { ok: true } };
  });

  // A contrib's broker half calls this to raise an in-conversation approval interrupt
  // whose answer routes back via deps.resolveApproval; `:contrib` is not validated here so
  // a contrib deployed slightly ahead of the agent-host can still raise.
  r.post("/conversations/:id/approvals/:contrib", async (ctx) => {
    if (!(await fromService(ctx.req))) return serviceOnly;
    const body = await ctx.body<{
      request_id?: string;
      message?: string;
      options?: Array<{ optionId: string; name: string; kind: string }>;
    }>();
    if (!body.request_id) return { status: 400, json: { error: "request_id required" } };
    // The broker sends the sandbox key, not always the id.
    const conv =
      sessions.get(ctx.params.id) ?? (await sessions.getBySandboxKey(ctx.params.id));
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

  // Withdraws a card another approval superseded.
  r.del("/conversations/:id/approvals/:contrib/:requestId", async (ctx) => {
    if (!(await fromService(ctx.req))) return serviceOnly;
    const conv = sessions.get(ctx.params.id) ?? (await sessions.getBySandboxKey(ctx.params.id));
    if (!conv) return { status: 404, json: { error: "unknown conversation" } };
    return { json: { withdrawn: await withdrawApproval(conv.id as SessionId, ctx.params.requestId) } };
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

  // --- Themes (UI settings page and header toggle) -------------------------------
  r.get("/themes", async () => {
    if (!deps.themesDir) return { json: { themes: [], default: BUILTIN_THEME_ID } };
    const warn = (m: string) => log.warn(m);
    const themes = await loadThemes(deps.themesDir, warn);
    return { json: { themes, default: await loadDefaultThemeId(deps.themesDir, themes, warn) } };
  });

  r.get("/user-theme", async (ctx) => {
    const choice = deps.userThemes ? await deps.userThemes.get(skillOwner(ctx)) : undefined;
    return { json: { configurable: deps.userThemes !== undefined, ...(choice ?? {}) } };
  });

  r.patch("/user-theme", async (ctx) => {
    if (!deps.userThemes) return { status: 501, json: { error: "theme settings not configured" } };
    const { themeId, mode } = await ctx.body<{ themeId?: unknown; mode?: unknown }>();
    // Unknown ids are kept; the UI falls back meanwhile.
    if (themeId !== undefined && !isThemeId(themeId)) return { status: 400, json: { error: "themeId must be a lowercase slug" } };
    if (mode !== undefined && !isThemeMode(mode)) return { status: 400, json: { error: 'mode must be "light", "dark" or "system"' } };
    const owner = skillOwner(ctx);
    const current = (await deps.userThemes.get(owner)) ?? { mode: "system" as const };
    const next: UserTheme = { mode: isThemeMode(mode) ? mode : current.mode };
    const picked = isThemeId(themeId) ? themeId : current.themeId;
    if (picked !== undefined) next.themeId = picked;
    await deps.userThemes.set(owner, next);
    return { json: next };
  });

  // --- Conversation retention policy (settings page) ----------------------------
  r.get("/user-retention", async (ctx) => {
    const own = await userLifetime(ctx.user);
    return {
      json: {
        configurable: deps.userRetention !== undefined && !ctx.user.anonymous,
        deploymentLifetimeHours: deps.defaultLifetimeHours ?? 0,
        ...(own !== undefined ? { lifetimeHours: own } : {}),
      },
    };
  });

  r.patch("/user-retention", async (ctx) => {
    if (!deps.userRetention) return { status: 501, json: { error: "retention settings not configured" } };
    // Anonymous callers share one id, so one can't set everyone's default.
    if (ctx.user.anonymous) return { status: 401, json: { error: "sign in to set a retention policy" } };
    const { lifetimeHours } = await ctx.body<{ lifetimeHours?: unknown }>();
    if (lifetimeHours !== null && !isLifetimeHours(lifetimeHours))
      return { status: 400, json: { error: "lifetimeHours must be null (default) or 0 (forever) to 87600" } };
    await deps.userRetention.set(ctx.user.id, lifetimeHours);
    return { json: { lifetimeHours } };
  });

  // --- Contrib settings-tab API -------------------------------------------------
  // The broker keys a conversation by its sandbox key.
  if (deps.contribApi) {
    mountContribApi(r, {
      conversationKey: async (id) => {
        const conv = sessions.get(id) ?? (await sessions.getBySandboxKey(id));
        return conv ? sandboxKey(conv.sandbox.name) : null;
      },
      ...deps.contribApi,
    });
  }

  return r;
}
