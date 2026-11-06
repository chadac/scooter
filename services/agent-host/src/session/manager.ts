/**
 * Session manager: owns conversation lifecycle in the agent-host.
 *
 * Per conversation it ties together a cold per-conversation Sandbox (the
 * provisioner), a goose ACP process behind the ACP<->AG-UI bridge (SessionBridge),
 * the durable event log and metadata (the store), and the AG-UI connections to
 * the browser.
 */

import type { SessionId, ThreadId, SandboxRef } from "../types.js";
import type { JobRecord } from "./jobManager.js";
import type { SessionBridge, AguiEvent, InterruptPolicy, PromptImage, PromptFile, MessageSender } from "../bridge.js";
import { danglingRunInfo, orphanRuns } from "./danglingRun.js";
import { allowAllGuard, type OwnershipGuard } from "./ownershipGuard.js";
import { noopRegistry, type ConversationRecord, type ConversationRegistry } from "./conversationRegistry.js";
import { formatError, logger } from "../log.js";
import { DERIVED_SOURCES, humanTriggerFromLog } from "../acp/remoteAgentRegistry.js";
import type { AccessFacts, Visibility } from "./visibility.js";

const log = logger("manager");

/** The synthetic prompt sent to resume a run interrupted by an agent-host restart: a nudge to
 *  continue rather than the user's literal prompt, which would redo work. */
const RESUME_NUDGE =
  "[System: this conversation was interrupted by a restart while you were working. " +
  "Continue where you left off — do NOT restart the task, re-introduce yourself, or " +
  "repeat a message/comment you already posted. If you had already finished, a brief " +
  "status is fine.]";

/** The synthetic prompt sent after an agent-initiated model switch, whose turn was cancelled to
 *  apply it. */
const MODEL_SWITCH_NUDGE =
  "[System: your model was switched at your request; the previous turn was ended to " +
  "apply it. Continue where you left off on the new model — do NOT restart the task, " +
  "re-introduce yourself, or repeat anything you already did or posted.]";

/** The title a conversation is created with, before the agent's <title> marker names it. */
export const PLACEHOLDER_TITLE = "New chat";

/** The stored fields the router or another replica may change behind this one. */
export interface RouterMeta extends AccessFacts {
  title: string;
  userTitled: boolean;
  starred: boolean;
}

/** Whether a title is still the create-time placeholder, i.e. the conversation is unnamed. */
export function isPlaceholderTitle(title: string | undefined): boolean {
  return (title ?? "").trim() === "" || title === PLACEHOLDER_TITLE;
}

/** An event plus the rolling integrity checksum before it (`prevChecksum`) and through it
 *  (`checksum`). */
export interface ChecksummedEvent {
  event: AguiEvent;
  prevChecksum: string;
  checksum: string;
}

/** Provisions, suspends, resumes and destroys the per-conversation Sandbox. */
export interface SandboxProvisioner {
  /** Cold-create a Sandbox named by the short DNS-1123-safe `conversationId`; `threadId` is the
   *  full conversation id used for its CONVERSATION_URL (defaults to `conversationId`). */
  create(conversationId: string, threadId?: string): Promise<SandboxRef>;
  /** Set operatingMode Suspended: drop the pod, keep the PVCs and the Sandbox object. */
  suspend(ref: SandboxRef): Promise<void>;
  /** Set operatingMode Running: recreate the pod and re-mount the PVCs. */
  resume(ref: SandboxRef, threadId?: string): Promise<SandboxRef>;
  /** Delete the Sandbox and GC its per-conversation SA/RBAC. */
  destroy(ref: SandboxRef): Promise<void>;
  /** List the live per-conversation Sandboxes with whether each pod is currently running, so
   *  hydrate() tracks still-running pods; optional. */
  reconcile?(): Promise<Array<{ ref: SandboxRef; running: boolean }>>;
  /** Changes a restart would pick up; undefined when none. */
  pendingRestart?(ref: SandboxRef): Promise<PendingRestart | undefined>;
  /** Cycles the pod onto the current template and size. */
  restart?(ref: SandboxRef, hooks?: { onRunning?: () => void }): Promise<SandboxRestartResult>;
}

export interface PendingRestart {
  /** Current and target image, when they differ. */
  image?: { from: string; to: string };
  /** Platform pod-template fields a restart would change. */
  template?: string[];
  /** Conversation env (CONVERSATION_URL etc.) is stale. */
  env?: boolean;
  /** The running pod lacks the recorded size. */
  size?: boolean;
}

export interface SandboxRestartResult {
  /** Image before and after the restart. */
  fromImage?: string;
  toImage?: string;
  /** False when the image reconcile failed. */
  imageCurrent: boolean;
  /** The restart applied a pending size. */
  sizeApplied: boolean;
  /** The new pod became Ready in time. */
  ready: boolean;
}

/** Who chose a conversation's model. */
export type ModelSetBy = "user" | "agent";

/** Durable, restart-surviving metadata for one conversation. */
export interface ConversationMeta {
  id: SessionId;
  threadId: ThreadId;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  /** Per-conversation model override (undefined = host default). */
  model?: string;
  modelSetBy?: ModelSetBy;
  /** Creating user (ingress identity); undefined = unowned/public. */
  owner?: string;
  /** The spawning conversation when this is a subagent, which shares its parent's sandbox pod. */
  parentId?: SessionId;
  /** The user renamed this conversation, so the agent's <title> marker no longer overwrites
   *  `title`. */
  userTitled?: boolean;
  /** The user starred this conversation, which exempts it from retention reaping but not from
   *  idle-suspend. */
  starred?: boolean;
  /** shared (default) or private (owner only). The Postgres store never writes it from saveMeta,
   *  only from setVisibility, so a stale full-row save cannot flip a private conversation back. */
  visibility?: Visibility;
  /** Messages still queued in the bridge when the conversation was suspended; revive() re-enqueues
   *  them and clears the field. */
  pendingQueue?: Array<{ text: string; priority: number; source?: string; sender?: MessageSender; humanInitiated?: boolean }>;
  /** The Sandbox a top-level conversation runs in; absent on older records. */
  sandboxRef?: string;
}

/** An external resource a conversation is linked to (GitHub PR/issue, GitLab MR, Slack thread, Jira
 *  ticket), pushed by the webhooks service and shown in the UI's linked-resources panel. */
export interface ConversationLink {
  /** "github" | "gitlab" | "slack" | "jira" | … (drives the icon). */
  source: string;
  /** "pull_request" | "issue" | "merge_request" | "thread" | "ticket" | … */
  resourceType: string;
  /** A clickable URL to the resource, when known. */
  url?: string;
  /** A short human label (e.g. "example-org/example-app #203", "#eng-help thread"). */
  title?: string;
  /**
   * Structured target identifiers the agent-tools use to infer where to respond, populated
   * by push_link: slack `{ channel, threadTs }`, gitlab `{ projectId, mrIid }` for a merge
   * request or `{ projectId, iid }` for an issue, github `{ owner, repo, number }`, jira
   * `{ issueKey }`.
   */
  ref?: {
    channel?: string;
    threadTs?: string;
    projectId?: string;
    mrIid?: string;
    iid?: string;
    owner?: string;
    repo?: string;
    number?: number;
    issueKey?: string;
  };
}

/** Durable conversation store: event-log replay plus the goose state pointer. */
export interface ConversationStore {
  appendEvent(id: SessionId, event: AguiEvent): Promise<void>;
  /** Await every append enqueued so far for `id` to be durably written, since appendEvent is
   *  fire-and-forget; optional. */
  flush?(id: SessionId): Promise<void>;
  readEvents(id: SessionId): AsyncIterable<AguiEvent>;
  /** Like readEvents, but each item carries the rolling integrity checksum computed from the
   *  persisted log order; optional. */
  readEventsWithChecksum?(id: SessionId): AsyncIterable<ChecksummedEvent>;
  /** Atomically replace a conversation's entire event log with `events`, resetting the rolling
   *  checksum; optional and reconciliation-only. */
  replaceEvents?(id: SessionId, events: AguiEvent[]): Promise<void>;
  /** The events of the last `runs` runs, read without parsing the whole log; optional. */
  readEventsTail?(id: SessionId, runs: number): Promise<AguiEvent[]>;
  /** The last `limit` events by seq; optional. */
  readEventsTailByCount?(id: SessionId, limit: number): Promise<AguiEvent[]>;
  readEventsBefore?(
    id: SessionId,
    beforeSeq: number,
    limit: number,
  ): Promise<{ events: AguiEvent[]; firstSeq: number; done: boolean }>;
  /** Subscribe to events as they are durably appended, each carrying its rolling checksum, and get
   *  back an unsubscribe fn; optional. */
  onAppend?(cb: (id: SessionId, event: ChecksummedEvent) => void): () => void;
  /** Subscribe to durable-append failures and get back an unsubscribe fn; optional. */
  onAppendError?(cb: (id: SessionId, error: unknown) => void): () => void;
  /** Path on the conversation-state PVC where goose session data lives. */
  gooseStatePath(id: SessionId): string;
  /** Persist conversation metadata so the list survives a restart; optional. */
  saveMeta?(meta: ConversationMeta): Promise<void>;
  /** The router-owned star and title as persisted; optional. */
  readRouterMeta?(id: SessionId): Promise<Partial<RouterMeta> | undefined>;
  /** Folder lifetimes in hours, 0 = forever, for filed `ids`. */
  readLifetimes?(ids: SessionId[]): Promise<Map<SessionId, number>>;
  /** Set the visibility of `rootId` and every descendant in one write; optional. */
  setVisibility?(rootId: SessionId, visibility: Visibility): Promise<void>;
  /** Read a conversation's owner and visibility fresh from the shared store, since another
   *  replica (or the router) may have changed them; undefined when the store cannot say. */
  readAccess?(id: SessionId): Promise<AccessFacts | undefined>;
  /** Raise a conversation's persisted lastActivityAt to `at` without lowering it, whether or not
   *  this replica holds the conversation; optional. */
  touchActivity?(id: SessionId, at: number): Promise<void>;
  /** The persisted lastActivityAt, which another replica's touch may have raised; optional. */
  readLastActivity?(id: SessionId): Promise<number | undefined>;
  /** Reconstruct all persisted conversations; optional. */
  listConversations?(): Promise<ConversationMeta[]>;
  /** Permanently remove a conversation's persisted state so it does not reappear on the next
   *  hydrate(); optional. */
  removeConversation?(id: SessionId): Promise<void>;
  /** Record an external resource link for a conversation (deduped); optional. */
  addLink?(id: SessionId, link: ConversationLink): Promise<void>;
  /** The conversation's external resource links; optional. */
  listLinks?(id: SessionId): Promise<ConversationLink[]>;
  /** Append a background-job record so list_background survives a restart; optional. */
  saveJob?(id: SessionId, job: JobRecord): Promise<void>;
  /** The conversation's background-job records (newest first; [] if none). */
  listJobs?(id: SessionId): Promise<JobRecord[]>;
  /** Update a job record in place by jobId; optional. */
  updateJob?(id: SessionId, job: JobRecord): Promise<void>;
}

/**
 * A prompt arrived for a conversation that does not exist. The agent-host never
 * creates one implicitly: conversations are created by the conversation-router
 * (services/conversation-router/create.go), so a caller-chosen id can never become
 * a conversation id, an event-log key, or a k8s resource name.
 */
export class UnknownConversationError extends Error {
  constructor(readonly threadId: string) {
    super(`unknown conversation: ${threadId}`);
    this.name = "UnknownConversationError";
  }
}

export type ConversationStatus = "running" | "suspended" | "ended";

export interface Conversation {
  readonly id: SessionId;
  readonly threadId: ThreadId;
  readonly sandbox: SandboxRef;
  readonly bridge?: SessionBridge;
  readonly status: ConversationStatus;
  readonly title: string;
  readonly createdAt: number;
  /** ms epoch of the last prompt or agent event; drives idle-suspend. */
  readonly lastActivityAt: number;
  /** Model this conversation runs on (undefined = the host default). */
  readonly model?: string;
  readonly modelSetBy?: ModelSetBy;
  /** The user who created it (the ingress identity); undefined = unowned/public, and a view filter
   *  rather than an access boundary. */
  readonly owner?: string;
  /** The spawning conversation when this is a subagent; children are found by scanning for
   *  `parentId === id`. */
  readonly parentId?: SessionId;
  /** The title is user-set and locked against the agent's <title> marker. */
  readonly userTitled?: boolean;
  /** The user starred it. */
  readonly starred?: boolean;
  /** shared (default) or private; a subagent always has its root's. */
  readonly visibility?: Visibility;
}

export interface SessionManager {
  /** Start a brand-new conversation (cold Sandbox + goose + PVCs) on `model`, owned by `owner`. */
  start(threadId: ThreadId, model?: string, owner?: string, opts?: { visibility?: Visibility }): Promise<Conversation>;
  /** Spawn a subagent: a new conversation with its own bridge that shares the parent's sandbox pod,
   *  inherits its owner and carries `parentId`; throws if the parent is unknown. */
  spawnChild(
    parentId: SessionId,
    childThreadId: ThreadId,
    args: { prompt: string; title?: string; model?: string },
  ): Promise<Conversation>;
  /** Subscribe to subagent completions, fired as (subagentId, parentId) when a subagent's run
   *  finishes or errors (an interrupt pause does not count); returns an unsubscribe. */
  onSubagentComplete(cb: (subagentId: SessionId, parentId: SessionId) => void): () => void;
  /** Revive a suspended conversation already known to this pod: resume the sandbox and rebuild the
   *  bridge. */
  revive(id: SessionId): Promise<Conversation>;
  /** Revive a conversation this pod was just assigned, which may be unknown to it; idempotent, and
   *  a push whose `expectedGen` is stale is a no-op. */
  reviveFromMirror(id: SessionId, expectedGen: number): Promise<void>;
  /** Settle a conversation's dangling last run on this pod by terminating it (persisted cancel
   *  intent) or resume-nudging it; owner-fenced by callers, one reconciliation in flight per
   *  conversation. */
  reconcileDanglingRun(id: SessionId, expectedGen?: number): Promise<void>;
  /** Cancel and drop this pod's bridge for a conversation it lost. */
  relinquish(id: SessionId): Promise<void>;
  /** A write was fenced: cancel and drop this pod's bridge, whatever the cache says. */
  stopFencedRun(id: SessionId): Promise<void>;
  /** Make a conversation's history readable on this pod without starting its sandbox or bridge;
   *  returns false when the conversation is genuinely unknown. */
  ensureReadable(id: SessionId): Promise<boolean>;
  /** Re-read a bridgeless entry's Sandbox ref and status from the cluster, since a hydrated entry
   *  freezes what reconcile saw at hydrate time (often a placeholder for a Sandbox mid-create);
   *  throttled per conversation, and a no-op while a live bridge owns the ref. */
  refreshSandbox?(id: SessionId): Promise<void>;
  /** Forward a user prompt into the conversation's goose session; a differing `model` rebuilds the
   *  session on the new model, and `priority` lets an @mention interrupt a running turn. */
  prompt(id: SessionId, text: string, model?: string, priority?: number, interrupt?: InterruptPolicy, images?: PromptImage[], files?: PromptFile[], source?: string): Promise<void>;
  /** Find-or-start the conversation for an AG-UI thread and prompt it, where `model` picks the
   *  conversation's model on the first prompt and switches it on a later one, `owner` stamps a
   *  conversation newly started here, and `images`/`files` are attachments the bridge resolves
   *  or writes to /workspace/uploads. */
  promptByThread(threadId: ThreadId, text: string, model?: string, priority?: number, owner?: string, images?: PromptImage[], files?: PromptFile[], source?: string, provider?: string, sender?: MessageSender): Promise<void>;
  /** promptByThread, but resolved once the prompt is queued rather than when its run ends, for a
   *  caller that only hands a message over (POST /messages): a caller that timed out waiting for
   *  the run would resend a message the agent already has; `source` tags it as a system event.
   *  A `priority` (PRIORITY_INTERRUPT) preempts the running turn at its next tool-call boundary.
   *  Finding or reviving still throws. */
  enqueueByThread(threadId: ThreadId, text: string, source?: string, priority?: number): Promise<void>;
  /** Switch a running conversation's model mid-turn for the switch_model tool, cancelling the
   *  in-flight run, rebuilding goose on the new model and re-nudging it to continue; a no-op if
   *  `model` is current, throws on an unknown conversation, and returns whether a switch happened. */
  switchModelNow(id: SessionId, model: string): Promise<boolean>;
  /** Pending restart changes for this conversation's sandbox. */
  pendingRestart?(id: SessionId): Promise<PendingRestart | undefined>;
  /** Restarts the sandbox (the root's, for a subagent). */
  restartSandbox?(id: SessionId): Promise<SandboxRestartResult>;
  /** Stops the sandbox; mid-run, suspends once the run ends. */
  stopSandbox?(id: SessionId): Promise<{ deferred: boolean; pending?: PendingRestart }>;
  /** A sandbox call resumed the pod; cancel deferred stops. */
  noteSandboxResumed?(id: SessionId): void;
  suspend(id: SessionId): Promise<void>;
  end(id: SessionId): Promise<void>;

  get(id: SessionId): Conversation | undefined;
  /** Whether end() tore this conversation down on this pod, so nothing may provision for it again. */
  isEnded?(id: SessionId): boolean;
  /** A top-level conversation by the broker's sandbox key; undefined if ambiguous. */
  getBySandboxKey(key: string): Promise<Conversation | undefined>;
  /** Mark a conversation active now so the idle sweep does not suspend it, for non-agent activity
   *  such as web-service proxy traffic. Recorded in the shared store too, because a long-lived
   *  proxied WebSocket stays on the replica it connected through while the owner (the one that
   *  sweeps) may have moved. */
  touchById(id: SessionId): void;
  /** All conversations, newest first. */
  list(): Conversation[];
  /** Set the title from the agent's <title> marker and return the persist promise; a no-op once the
   *  conversation is named, which `force` (a deliberate rename through set_conversation_title)
   *  overrides — a user rename locks the title against both. */
  setTitle(id: SessionId, title: string, opts?: { force?: boolean }): Promise<void>;
  /** Pull the router-owned star and title into memory; throws on a failed read. */
  refreshRouterMeta(id: SessionId): Promise<void>;
  /** Set a top-level conversation's visibility and every descendant's (they share its pod);
   *  throws for a subagent, or for private on an unowned conversation. */
  setVisibility(id: SessionId, visibility: Visibility): Promise<void>;
  /** Load persisted conversations into the in-memory list after a restart; persisted-but-not-live
   *  ones come back as "suspended". */
  hydrate(): Promise<void>;
  /**
   * Revive each conversation whose last run was interrupted by a restart and send it a
   * continue nudge, with bounded concurrency; returns the ids resumed.
   */
  resumeInterrupted(opts?: { concurrency?: number }): Promise<SessionId[]>;
  /**
   * Suspend conversations idle longer than idleMs; returns the ids suspended.
   */
  sweepIdle(idleMs: number, now?: number): Promise<SessionId[]>;

  /** End idle top-level conversations past their folder's or default lifetime. */
  sweepRetention(maxAgeMs: number, now?: number): Promise<SessionId[]>;
}

/** Builds the ACP<->AG-UI bridge for a conversation (spawns goose in prod). */
export type BridgeFactory = (args: {
  conversationId: SessionId;
  sandbox: SandboxRef;
  /** Per-conversation model override (undefined = host default). */
  model?: string;
  /** The explicitly picked provider, for the per-run resolver. */
  pickedProvider?: string;
  /** The conversation owner, passed to the bridge's per-run ACP provider resolver so an
   *  owner-bound provider (the BYO remote agent) can route this conversation to that user's
   *  agent; undefined for an unowned/anonymous conversation. */
  owner?: string;
  /** Settles once the Sandbox is provisioned; start() awaits it. */
  sandboxReady?: () => Promise<void>;
}) => SessionBridge | undefined;

export interface SessionManagerDeps {
  provisioner: SandboxProvisioner;
  store: ConversationStore;
  /** Multi-replica fencing guard consulted before this pod appends to a conversation's log; omitted
   *  = allowAllGuard. */
  ownershipGuard?: OwnershipGuard;
  /** Multi-replica assignment table (the conversations row) that publishes placement hints and
   *  phase and answers which pod hosts a conversation; omitted = noopRegistry. */
  conversationRegistry?: ConversationRegistry;
  /** This pod's name (POD_NAME); when set with a registry that can list(), hydrate() adopts every
   *  conversation assigned to this pod. */
  selfPod?: string;
  /** How to build a bridge per conversation; omitted in lifecycle-only unit tests. */
  bridgeFactory?: BridgeFactory;
  /** Called with a live bridge after revive() rebuilds it, so the host can re-raise approval
   *  interrupts still pending in the broker; fire-and-forget. */
  onRevived?: (id: SessionId) => void;
  /** Whether the conversation has a running background job; sweepIdle consults it and fails open on
   *  a throw. */
  hasRunningBackgroundJob?: (id: SessionId) => Promise<boolean>;
  /** Called after a stop or restart so exec clients reconnect. */
  onSandboxCycled?: (ref: SandboxRef) => void;
  /** Wait before resuming another pod's run; default 0. */
  handoffGraceMs?: number;
}

interface Entry {
  id: SessionId;
  threadId: ThreadId;
  sandbox: SandboxRef;
  bridge?: SessionBridge;
  status: ConversationStatus;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  model?: string;
  modelSetBy?: ModelSetBy;
  /** The explicitly picked provider, persisted so a resume keeps the swap. */
  pickedProvider?: string;
  owner?: string;
  parentId?: SessionId;
  userTitled?: boolean;
  starred?: boolean;
  visibility?: Visibility;
  /** Messages still queued in the bridge when this conversation was suspended, for revive() to
   *  re-enqueue. */
  pendingQueue?: Array<{ text: string; priority: number; source?: string; sender?: MessageSender; humanInitiated?: boolean }>;
  /** Suspend the sandbox when this run ends (in memory). */
  stopAfterRun?: boolean;
}

/** Drain an async iterable of events into an array. */
async function collectEvents(it: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** Older sandboxes' 32-bit name hash; it collides, so retired. */
export function shortId(threadId: string): string {
  let h = 0;
  for (let i = 0; i < threadId.length; i++) h = (h * 31 + threadId.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** An id short and safe enough for every derived k8s name. */
const SANDBOX_ID = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;

/** The Sandbox a new top-level conversation runs in. */
export function sandboxNameFor(id: string): string {
  if (!SANDBOX_ID.test(id)) throw new Error(`conversation id ${JSON.stringify(id)} cannot name a sandbox`);
  return `conv-${id}`;
}

/** The broker's conversation key, from the Sandbox name. */
export function sandboxKey(sandboxName: string): string {
  return sandboxName.replace(/^conv-/, "");
}

/** Recorded Sandbox, else conv-<id> if on cluster, else legacy. */
export function rootSandboxName(
  m: { threadId: ThreadId; sandboxRef?: string },
  onCluster?: (name: string) => boolean,
): string {
  if (m.sandboxRef) return m.sandboxRef;
  const full = `conv-${m.threadId}`;
  // Unrecorded means pre-rename; its workspace PVC keeps the legacy name.
  if (onCluster?.(full) && SANDBOX_ID.test(m.threadId)) return full;
  return `conv-${shortId(m.threadId)}`;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { provisioner, store, bridgeFactory } = deps;
  const ownershipGuard = deps.ownershipGuard ?? allowAllGuard;
  const conversationRegistry = deps.conversationRegistry ?? noopRegistry;
  const entries = new Map<SessionId, Entry>();

  // Fired when a subagent's bridge emits a terminal RUN_FINISHED/RUN_ERROR.
  const subagentCompleteSubs = new Set<(subagentId: SessionId, parentId: SessionId) => void>();
  const emitSubagentComplete = (subagentId: SessionId, parentId: SessionId): void => {
    for (const cb of subagentCompleteSubs) {
      try { cb(subagentId, parentId); } catch (err) {
        // eslint-disable-next-line no-console
        log.errorWith("onSubagentComplete listener threw", err, { subagent_id: subagentId });
      }
    }
  };

  const toConversation = (e: Entry): Conversation => ({
    id: e.id,
    threadId: e.threadId,
    sandbox: e.sandbox,
    bridge: e.bridge,
    status: e.status,
    title: e.title,
    createdAt: e.createdAt,
    lastActivityAt: e.lastActivityAt,
    model: e.model,
    modelSetBy: e.modelSetBy,
    owner: e.owner,
    parentId: e.parentId,
    userTitled: e.userTitled,
    starred: e.starred,
    visibility: e.visibility,
  });

  // Mark the conversation active now; fire-and-forget because it runs on the prompt path and proxy
  // traffic.
  const touch = (e: Entry) => {
    e.lastActivityAt = nowMs();
    void saveMeta(e);
  };

  /** The Sandbox name a conversation runs in: its root ancestor's, since subagents share it. */
  type Lineage = { threadId: ThreadId; parentId?: SessionId; sandboxRef?: string; sandbox?: SandboxRef };
  const sandboxNameOf = (
    m: Lineage,
    lookup: (id: SessionId) => Lineage | undefined,
    onCluster?: (name: string) => boolean,
  ): string => {
    let cur = m;
    for (let depth = 0; cur.parentId && depth < 32; depth++) {
      const up = entries.get(cur.parentId) ?? lookup(cur.parentId);
      // Broken chain: revive() refuses, so the name is never provisioned.
      if (!up) break;
      cur = up;
    }
    return cur.sandbox?.name ?? rootSandboxName(cur, onCluster);
  };

  // Build an in-memory Entry from a persisted meta, with no bridge; `onCluster` is the reconcile
  // result for its Sandbox.
  const hydrateEntry = (
    m: ConversationMeta,
    onCluster: { ref: SandboxRef; running: boolean } | undefined,
    name: string,
  ): Entry => {
    const entry: Entry = {
      id: m.id,
      threadId: m.threadId,
      // Keep the real ref for any Sandbox that exists on the cluster so revive() resumes it; the
      // empty-namespace placeholder tells revive() to create from scratch.
      sandbox: onCluster ? onCluster.ref : { name, namespace: "" },
      bridge: undefined,
      status: onCluster?.running ? "running" : "suspended",
      title: m.title,
      createdAt: m.createdAt,
      lastActivityAt: m.lastActivityAt,
      model: m.model,
      modelSetBy: m.modelSetBy,
      owner: m.owner,
      parentId: m.parentId,
      userTitled: m.userTitled,
      starred: m.starred,
      pendingQueue: m.pendingQueue,
      visibility: m.visibility,
    };
    entries.set(m.id, entry);
    return entry;
  };

  // On-demand hydration of one thread from the store or the registry; returns undefined when
  // neither has it or the store read fails.
  const hydrateByThread = async (threadId: ThreadId): Promise<Entry | undefined> => {
    let metas: ConversationMeta[];
    try {
      metas = (await store.listConversations?.()) ?? [];
    } catch (err) {
      // eslint-disable-next-line no-console
      log.errorWith("hydrateByThread store lookup failed; may create a duplicate", err, {
        conversation_id: threadId,
      });
      return undefined;
    }
    let m = metas.find((x) => x.threadId === threadId);
    const fromStore = m !== undefined;
    let unrecorded: ConversationRecord | undefined;
    if (!m) {
      // The registry is authoritative for existence, so adopt from it when the store list missed it
      // (a row inserted after the list was read).
      const c = await conversationRegistry.get(threadId).catch(() => undefined);
      if (!c) return undefined;
      m = {
        id: c.id,
        threadId: c.id,
        title: "",
        createdAt: nowMs(),
        lastActivityAt: nowMs(),
        model: c.spec.model,
        owner: c.spec.owner,
        parentId: c.spec.parentId,
        visibility: c.spec.visibility,
        ...(c.spec.sandboxRef ? { sandboxRef: c.spec.sandboxRef } : {}),
      };
      if (!c.spec.sandboxRef) unrecorded = c;
    }
    if (entries.has(m.id)) return entries.get(m.id);
    // Never re-adopt a conversation end() destroyed.
    if (endedIds.has(m.id)) return undefined;
    // Reconcile this conversation's Sandbox so a still-running pod is tracked; on failure revive()
    // recreates from the placeholder.
    let sandboxes: Array<{ ref: SandboxRef; running: boolean }> | undefined;
    try {
      sandboxes = (await provisioner.reconcile?.()) ?? [];
    } catch {
      /* treat as suspended */
    }
    const metaById = new Map(metas.map((x) => [x.id, x]));
    const has = sandboxes && ((n: string) => sandboxes.some((x) => x.ref.name === n));
    const name = sandboxNameOf(m, (pid) => metaById.get(pid), has);
    const onCluster = sandboxes?.find((x) => x.ref.name === name);
    // Publish sandboxRef early so the router can route by it.
    if (unrecorded) {
      void conversationRegistry.register(unrecorded.id, {
        model: unrecorded.spec.model,
        owner: unrecorded.spec.owner,
        parentId: unrecorded.spec.parentId,
        sandboxRef: name,
        creatorPod: deps.selfPod, // placement hint for the controller
      });
    }
    // Re-check after the awaits: concurrent first requests for one conversation (the prompt, its
    // history read, the event stream) all pass the check above, and a later one would otherwise
    // replace the entry an earlier one already revived. That orphans the live bridge: the run
    // keeps going, but a Stop then finds a bridgeless "suspended" entry and does nothing.
    const existing = entries.get(m.id);
    if (existing) return existing;
    if (endedIds.has(m.id)) return undefined;
    const hydrated = hydrateEntry(m, onCluster, name);
    // Settle any stranded run on every adoption path; owner-fenced, fire-and-forget, deduped by the
    // in-flight guard.
    if (hydrated && ownershipGuard.canWrite(hydrated.id)) {
      void api.reconcileDanglingRun(hydrated.id);
      // Persist CR-synthesized metadata so the conversation list sees a conversation adopted but
      // never prompted.
      if (!fromStore) void saveMeta(hydrated);
    }
    return hydrated;
  };

  // Ids end() has torn down; a late write for one must never land, since it would resurrect the
  // conversation with a pod the delete was meant to reclaim.
  const endedIds = new Set<SessionId>();
  const ENDED_TOMBSTONES = 4096;
  const tombstone = (id: SessionId) => {
    // Bounded FIFO: Set preserves insertion order, so the first key is the oldest.
    if (endedIds.size >= ENDED_TOMBSTONES) {
      const oldest = endedIds.values().next();
      if (!oldest.done) endedIds.delete(oldest.value);
    }
    endedIds.add(id);
  };

  // A subagent tree shares its root's trigger; a missing ancestor fails closed.
  const inheritedHumanTrigger = async (e: Entry): Promise<boolean> => {
    let root = e;
    for (let d = 0; root.parentId && d < 32; d++) {
      const up = entries.get(root.parentId);
      if (!up) return false;
      root = up;
    }
    if (root.parentId) return false;
    return humanTriggerFromLog(await collectEvents(store.readEvents(root.id)));
  };

  // Each conversation's last meta write, so writes land in call order.
  const metaWrites = new Map<SessionId, Promise<unknown>>();
  // Returns the persist promise so callers that need durability can await it.
  const saveMeta = (e: Entry): Promise<void> => {
    if (endedIds.has(e.id) || !store.saveMeta) return Promise.resolve();
    // Snapshot now: a later write must not persist an earlier state.
    const meta: ConversationMeta = {
      id: e.id,
      threadId: e.threadId,
      title: e.title,
      createdAt: e.createdAt,
      lastActivityAt: e.lastActivityAt,
      model: e.model,
      modelSetBy: e.modelSetBy,
      owner: e.owner,
      parentId: e.parentId,
      userTitled: e.userTitled,
      starred: e.starred,
      visibility: e.visibility,
      pendingQueue: e.pendingQueue,
      ...(e.parentId ? {} : { sandboxRef: e.sandbox.name }),
    };
    const prev = metaWrites.get(e.id);
    const write = prev
      ? prev.then(() => (endedIds.has(e.id) ? undefined : store.saveMeta!(meta)))
      : store.saveMeta(meta);
    const tail = write.catch(() => {});
    metaWrites.set(e.id, tail);
    void tail.then(() => {
      if (metaWrites.get(e.id) === tail) metaWrites.delete(e.id);
    });
    return write;
  };

  // The router and other replicas write these without telling this one.
  const refreshRouterMeta = async (e: Entry): Promise<void> => {
    const m = await store.readRouterMeta?.(e.id);
    if (!m) return;
    // An absent or undefined key leaves the entry's value unchanged.
    if (m.owner !== undefined) e.owner = m.owner;
    if (m.visibility !== undefined) e.visibility = m.visibility;
    if (m.starred !== undefined) e.starred = m.starred;
    if (m.userTitled !== undefined) e.userTitled = m.userTitled;
    if (e.userTitled && m.title !== undefined) e.title = m.title;
  };

  // Wired bridges per conversation; detached ones may still be running.
  const wired = new Map<SessionId, Set<SessionBridge>>();
  // Bridges being killed; their remaining events are dropped.
  const doomed = new WeakSet<SessionBridge>();
  /** Dangling-run reconciliations in flight, so racing callers settle each conversation once. */
  const danglingReconciles = new Set<SessionId>();

  /** Close a suspended conversation's dangling run instead of re-driving it. */
  const closeIfSuspended = async (
    id: SessionId,
    run: { runId: string; threadId: string },
  ): Promise<boolean> => {
    const rec = await conversationRegistry.get(id).catch(() => undefined);
    if (rec?.phase !== "Suspended") return false;
    // Resuming would revive it, and its Sandbox, behind the suspend.
    log.info("dangling run on a suspended conversation — closing, not resuming", {
      conversation_id: id,
      run_id: run.runId,
    });
    await store.appendEvent(id, {
      type: "RUN_FINISHED",
      threadId: run.threadId as never,
      runId: run.runId as never,
      cancelled: true,
      ts: Date.now(),
    });
    return true;
  };
  // refreshSandbox throttle: conversation -> last cluster read.
  const REFRESH_SANDBOX_MS = 5_000;
  const lastSandboxRefresh = new Map<SessionId, number>();
  // Cancel and drop every bridge this pod has for `id`.
  const stopLocalRun = async (id: SessionId, why: string): Promise<void> => {
    // An in-flight revive would rebuild the bridge after teardown.
    await reviving.get(id)?.catch(() => {});
    const entry = entries.get(id);
    const bridges = new Set(wired.get(id));
    wired.delete(id);
    if (entry?.bridge) {
      bridges.add(entry.bridge);
      // Detach first so no prompt reaches the dying bridge.
      entry.bridge = undefined;
      entry.status = "suspended";
    }
    if (bridges.size === 0) return;
    const qs = [...bridges].map((b) => b.queueState?.());
    log.warn(`${why} — stopping this pod's run`, {
      conversation_id: id,
      bridges: bridges.size,
      running: qs.some((q) => q?.running),
      queued: qs.reduce((n, q) => n + (q?.queued ?? 0), 0),
    });
    for (const bridge of bridges) {
      doomed.add(bridge);
      // cancel() kills sandbox execs; stop() alone leaves them running.
      await bridge.cancel().catch((err: unknown) =>
        log.warn("cancel of a fenced run failed", { conversation_id: id, error: formatError(err) }),
      );
      await bridge.stop().catch((err: unknown) =>
        log.warn("bridge stop of a fenced run failed", { conversation_id: id, error: formatError(err) }),
      );
    }
  };
  // A failed write means this pod is not the writer.
  const killUnwritable = (id: SessionId, bridge: SessionBridge, why: string) => {
    if (doomed.has(bridge)) return;
    doomed.add(bridge);
    // Caught: an unhandled rejection would kill the process.
    stopLocalRun(id, why).catch((err: unknown) =>
      log.warn("stopping a fenced run failed", { conversation_id: id, error: formatError(err) }),
    );
  };
  const wireEventLog = (e: Entry) => {
    const bridge = e.bridge;
    if (!bridge) return;
    // Rewired (revived) means live again.
    doomed.delete(bridge);
    const set = wired.get(e.id) ?? new Set<SessionBridge>();
    // Drop detached bridges that are idle; they cannot run again.
    for (const b of set) if (b !== bridge && !b.queueState?.().running) set.delete(b);
    wired.set(e.id, set.add(bridge));
    // Persist via onPersist only: it sees every event that should be logged exactly once, while
    // onEvent would double-log broadcasts.
    bridge.onPersist((event) => {
      if (doomed.has(bridge)) return;
      e.lastActivityAt = nowMs();
      // An interrupt pause doesn't end the run.
      if (
        e.stopAfterRun &&
        ((event.type === "RUN_FINISHED" && event.outcome?.type !== "interrupt") || event.type === "RUN_ERROR")
      ) {
        void finishDeferredStop(e);
      }
      // Cheap synchronous pre-filter; the store's AppendFence is the authority.
      if (!ownershipGuard.canWrite(e.id)) {
        // Loud: this drop truncates the run's log.
        log.warn("ownership fence dropped an event (reassigned mid-run?)", {
          conversation_id: e.id,
          event_type: event.type,
        });
        killUnwritable(e.id, bridge, "write fenced by the ownership cache");
        return;
      }
      // An unpersisted run must not keep acting unseen.
      store.appendEvent(e.id, event).catch(() => killUnwritable(e.id, bridge, "durable append failed"));
    });
  };

  /** Switch a conversation's model: update entry.model, tear down the live bridge fire-and-forget
   *  so the next prompt's revive relaunches goose with the new GOOSE_MODEL, and persist the
   *  change; a no-op when `model` is undefined or already current. */
  const applyModelSwitch = async (
    e: Entry,
    model?: string,
    provider?: string,
    setBy: ModelSetBy = "user",
  ): Promise<void> => {
    // A provider-only switch must rebuild too: `model` has not moved.
    const providerMoved = provider !== undefined && provider !== e.pickedProvider;
    if ((model === undefined || model === e.model) && !providerMoved) return;
    if (model !== undefined && model !== e.model) {
      e.model = model;
      e.modelSetBy = setBy;
    }
    if (provider !== undefined) e.pickedProvider = provider;
    if (e.bridge) {
      const old = e.bridge;
      e.bridge = undefined; // the next revive rebuilds with e.model
      // Fire-and-forget: don't block the next prompt on the old goose's exit.
      void old.stop().catch(() => {});
    }
    await saveMeta(e);
  };

  /** Find or revive the thread's conversation and queue the prompt. The run comes back boxed:
   *  an async function returning a bare promise would wait for that run to end. */
  async function queueByThread(
    threadId: ThreadId,
    text: string,
    model?: string,
    priority?: number,
    images?: PromptImage[],
    files?: PromptFile[],
    source?: string,
    provider?: string,
    sender?: MessageSender,
  ): Promise<{ run?: Promise<unknown> }> {
    return inArrivalOrder(threadId, async () => {
      // Find the conversation for this thread: in memory (revive if no live bridge), persisted
      // but not in memory (hydrate on demand and revive so a follow-up continues the existing
      // conversation), or genuinely new (start one, with the first prompt's model picking the
      // conversation's model).
      let entry = [...entries.values()].find((e) => e.threadId === threadId);
      if (!entry) {
        entry = await hydrateByThread(threadId);
      }
      if (!entry) {
        // Callers create explicitly via the router and prompt the id returned.
        throw new UnknownConversationError(threadId);
      }
      await applyModelSwitch(entry, model, provider);
      const bridge = await bridgeFor(entry);
      touch(entry);
      // A priority prompt (a webhook @mention) preempts with the "thinking" policy, which
      // interrupts idle text generation but lets an in-flight tool call finish.
      return {
        run: bridge?.prompt(
          { threadId, text, images, files, source, sender },
          priority ? { priority, interrupt: "thinking" } : undefined,
        ),
      };
    });
  }

  // Each thread's last queueing step; prompts queue strictly behind it.
  const queueTails = new Map<string, Promise<unknown>>();
  /** Runs `queue` after earlier ones for `key`, in arrival order. */
  const inArrivalOrder = <T>(key: string, queue: () => Promise<T>): Promise<T> => {
    const prev = queueTails.get(key);
    // Start now when uncontended; deferring reorders it against other requests.
    const next = prev ? prev.then(queue) : queue();
    const tail = next.catch(() => {});
    queueTails.set(key, tail);
    void tail.then(() => {
      if (queueTails.get(key) === tail) queueTails.delete(key);
    });
    return next;
  };

  // In-flight revive() per conversation, so concurrent callers share one revive.
  const reviving = new Map<SessionId, Promise<Conversation>>();
  // Per in-flight revive: the bridge, once it accepts prompts.
  const queueable = new Map<SessionId, Promise<SessionBridge | undefined>>();

  const sameRef = (a: SandboxRef, b: SandboxRef): boolean => a.name === b.name && a.namespace === b.namespace;

  /** Revives only until a bridge accepts prompts, then returns it. */
  const bridgeFor = async (entry: Entry): Promise<SessionBridge | undefined> => {
    if (entry.bridge) return entry.bridge;
    const done = api.revive(entry.id);
    const ready = queueable.get(entry.id);
    if (!ready) {
      await done;
      return entry.bridge;
    }
    // Its own bridge: a failing revive may detach entry.bridge first.
    const bridge = await Promise.race([ready, done.then(() => entry.bridge)]);
    // From here a failure surfaces as the queued run's RUN_ERROR.
    done.catch((err: unknown) => log.warn("revive failed behind a queued prompt", { conversation_id: entry.id, error: formatError(err) }));
    return bridge;
  };

  /** Re-enqueue what suspend() drained, skipping messages already logged. */
  const requeuePending = async (entry: Entry): Promise<void> => {
    const id = entry.id;
    // Clear and persist the field first so a failure cannot replay them twice.
    let pending = entry.pendingQueue ?? [];
    if (pending.length > 0) {
      // Skip messages already in the durable log: runPrompt persists the user message before
      // calling the agent, so an in-flight message would otherwise run twice.
      try {
        const tail = (await store.readEventsTail?.(id, 3)) ?? (await collectEvents(store.readEvents(id)));
        // Match only user turns: TEXT_MESSAGE_CONTENT carries no role, and an assistant reply
        // quoting the text must not suppress a replay.
        const userMsgIds = new Set<string>();
        const loggedUserTexts = new Set<string>();
        for (const e of tail) {
          const ev = e as { type?: string; delta?: string; role?: string; messageId?: string; source?: string; text?: string };
          // Sourced prompts log as SYSTEM_MESSAGE; hook notes are output.
          if (ev.type === "SYSTEM_MESSAGE" && ev.source !== "hook" && typeof ev.text === "string") {
            loggedUserTexts.add(ev.text);
          } else if (ev.type === "TEXT_MESSAGE_START" && ev.role === "user" && ev.messageId) {
            userMsgIds.add(ev.messageId);
          } else if (
            ev.type === "TEXT_MESSAGE_CONTENT" &&
            typeof ev.delta === "string" &&
            ev.messageId !== undefined &&
            userMsgIds.has(ev.messageId)
          ) {
            loggedUserTexts.add(ev.delta);
          }
        }
        const before = pending.length;
        pending = pending.filter((p) => !loggedUserTexts.has(p.text));
        if (pending.length !== before) {
          log.warn("revive: skipping already-logged messages (in-flight replay dedupe)", {
            conversation_id: id,
            skipped: before - pending.length,
          });
        }
      } catch (err) {
        // Replaying is the safer default on a read failure: a possible duplicate turn beats
        // dropping the user's message.
        log.errorWith("revive: replay dedupe read failed, replaying all", err, { conversation_id: id });
      }
    }
    if (pending.length > 0 || (entry.pendingQueue?.length ?? 0) > 0) {
      entry.pendingQueue = [];
      await saveMeta(entry);
      for (const item of pending) {
        // A queued message that fails to re-run must not fail the revive.
        void entry.bridge
          ?.prompt(
            { threadId: entry.threadId, text: item.text, source: item.source, sender: item.sender, humanInitiated: item.humanInitiated },
            item.priority ? { priority: item.priority } : undefined,
          )
          .catch((err) => {
            log.errorWith("re-enqueued message failed", err, { conversation_id: id });
          });
      }
    }
  };

  /** The entry owning `e`'s sandbox: itself or its root. */
  const rootEntry = (e: Entry): Entry => {
    let cur = e;
    for (let depth = 0; cur.parentId && depth < 32; depth++) {
      const up = entries.get(cur.parentId);
      if (!up) throw new Error(`subagent ${e.id} has no root conversation on this pod`);
      cur = up;
    }
    return cur;
  };
  const busy = (e: Entry): boolean => {
    const qs = e.bridge?.queueState();
    return !!qs && (qs.running || qs.queued > 0);
  };
  /** Another conversation with a run in flight on this sandbox. */
  const otherBusyOnSandbox = (root: Entry, self: SessionId): Entry | undefined => {
    const shares = (c: Entry): boolean => {
      for (let cur: Entry | undefined = c, d = 0; cur && d < 32; cur = cur.parentId ? entries.get(cur.parentId) : undefined, d++) {
        if (cur.id === root.id) return true;
      }
      return false;
    };
    for (const c of entries.values()) {
      if (c.id === self || c.status === "ended" || !shares(c)) continue;
      if (busy(c)) return c;
    }
    return undefined;
  };

  const clearDeferredStops = (root: Entry): void => {
    for (const c of entries.values()) {
      if (!c.stopAfterRun) continue;
      try {
        if (rootEntry(c) === root) c.stopAfterRun = false;
      } catch {
        c.stopAfterRun = false; // orphaned: its run's end has nothing left to suspend
      }
    }
  };

  /** Finishes a deferred stop once the bridge is idle. */
  const finishDeferredStop = async (e: Entry): Promise<void> => {
    // RUN_FINISHED lands before the bridge clears running.
    for (let i = 0; i < 50 && e.bridge?.queueState().running; i++) await new Promise((r) => setTimeout(r, 100));
    if (!e.stopAfterRun) return; // a later sandbox call revived it
    e.stopAfterRun = false;
    if (entries.get(e.id) !== e || e.status === "ended") return;
    let root: Entry;
    try {
      root = rootEntry(e);
    } catch {
      return;
    }
    // The pod is still in use; leave it running.
    if (root.status !== "running" || otherBusyOnSandbox(root, "" as SessionId)) return;
    try {
      await api.suspend(root.id);
      log.info("deferred stop_sandbox: conversation suspended after its run", { conversation_id: e.id });
    } catch (err) {
      log.warn("deferred stop_sandbox suspend failed", { conversation_id: e.id, error: formatError(err) });
    }
  };

  // Answering a colliding legacy hash could leak another conversation.
  const ambiguous = (key: string, n: number): undefined => {
    log.warn("sandbox key matches several conversations; refusing", { sandbox_key: key, conversations: n });
    return undefined;
  };

  const api: SessionManager = {
    async start(threadId, model, owner, opts) {
      const visibility = opts?.visibility ?? "shared";
      if (visibility === "private" && !owner) throw new Error("a private conversation needs an owner");
      // The conversation id is the thread id, and names its Sandbox.
      const id: SessionId = threadId;
      const name = sandboxNameFor(id);
      // Register the entry before the slow provisioning so the UI's immediate events.integrity GET
      // does not 404.
      const entry: Entry = {
        id, threadId, sandbox: { name, namespace: "" },
        bridge: undefined, status: "running",
        title: PLACEHOLDER_TITLE, createdAt: nowMs(), lastActivityAt: nowMs(), model, owner,
        ...(visibility === "private" ? { visibility } : {}),
        ...(model ? { modelSetBy: "user" as const } : {}),
      };
      entries.set(id, entry);
      await saveMeta(entry);
      // saveMeta never writes visibility to Postgres; this is its one writer.
      if (visibility === "private") await store.setVisibility?.(id, visibility);

      // Publish sandbox_ref and creator_pod before provisioning so the router can route and the
      // controller place it while the sandbox spins up; idempotent and non-throwing.
      await conversationRegistry.register(id, { model, owner, sandboxRef: entry.sandbox.name, creatorPod: deps.selfPod });

      // Provision the sandbox and attach the bridge.
      entry.sandbox = await provisioner.create(sandboxKey(name), threadId);
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model, owner: entry.owner });
      wireEventLog(entry); // after the bridge exists
      // Re-persist with the real sandbox ref so a crash mid-provision leaves a resumable entry.
      await saveMeta(entry);
      // bridge.prompt() lazily starts goose on first use, after emitting RUN_STARTED.
      return toConversation(entry);
    },

    async spawnChild(parentId, childThreadId, args) {
      const parent = entries.get(parentId);
      if (!parent) throw new Error(`unknown parent conversation: ${parentId}`);
      const id: SessionId = childThreadId;
      // A subagent shares the parent's sandbox pod, inherits its owner and carries parentId; its
      // bridge execs into the parent's pod with its own goose session.
      const model = args.model ?? parent.model;
      const entry: Entry = {
        id,
        threadId: childThreadId,
        sandbox: parent.sandbox, // shared, no provisioner.create
        bridge: undefined,
        status: "running",
        title: args.title ?? "Subagent",
        createdAt: nowMs(),
        lastActivityAt: nowMs(),
        model,
        owner: parent.owner,
        parentId,
        // It shares the parent's pod, so it is exactly as private (the router's insert agrees).
        ...(parent.visibility === "private" ? { visibility: "private" as const } : {}),
      };
      entries.set(id, entry);
      await saveMeta(entry);

      // Publish the child's sandbox_ref and creator_pod; its parent_id (set by the router's insert)
      // co-locates it on the parent's pod.
      await conversationRegistry.register(id, {
        model, owner: parent.owner, parentId, sandboxRef: entry.sandbox.name,
        creatorPod: deps.selfPod, // placement hint for the controller
      });

      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model, owner: entry.owner });
      wireEventLog(entry);
      // Fire onSubagentComplete when this subagent's run terminates; a RUN_FINISHED with outcome
      // "interrupt" is a pause, not a completion.
      entry.bridge?.onEvent((event) => {
        const done =
          (event.type === "RUN_FINISHED" && event.outcome?.type !== "interrupt") || event.type === "RUN_ERROR";
        if (done) emitSubagentComplete(id, parentId);
      });
      await saveMeta(entry);

      // Frame the prompt so the subagent ends its turn with a summary, which is what returns to the
      // parent.
      const framedPrompt =
        `${args.prompt}\n\n` +
        `---\n(You are a subagent. Do the task above, then END your turn with a ` +
        `concise summary of what you found or did — that final message is returned ` +
        `to the agent that spawned you.)`;
      // Fire-and-forget: prompt() resolves on run completion, and the parent is told via
      // onSubagentComplete.
      const humanInitiated = await inheritedHumanTrigger(entry);
      void entry.bridge?.prompt({ threadId: childThreadId, text: framedPrompt, humanInitiated }).catch((err: unknown) => {
        log.errorWith("subagent initial prompt failed", err, { conversation_id: id, parent_id: parentId });
      });
      return toConversation(entry);
    },

    async revive(id) {
      // Single-flight: concurrent callers must share one revive, or each builds its own bridge.
      const inflight = reviving.get(id);
      if (inflight) return inflight;
      let markQueueable!: (bridge: SessionBridge | undefined) => void;
      const accepting = new Promise<SessionBridge | undefined>((resolve) => { markQueueable = resolve; });
      queueable.set(id, accepting);
      const run = (async (): Promise<Conversation> => {
        const entry = entries.get(id);
        if (!entry) throw new Error(`unknown conversation: ${id}`);
        // A tombstoned entry may still be held by a caller that raced the delete.
        if (endedIds.has(id)) throw new Error(`conversation was ended: ${id}`);

        const buildBridge = (sandboxReady?: () => Promise<void>): SessionBridge | undefined => {
          entry.bridge = bridgeFactory?.({
            conversationId: id, sandbox: entry.sandbox, model: entry.model, pickedProvider: entry.pickedProvider,
            owner: entry.owner, sandboxReady,
          }) ?? entry.bridge;
          wireEventLog(entry);
          return entry.bridge;
        };
        // Built before provisioning, so prompts queue during the cold start.
        let early: SessionBridge | undefined;
        if (entry.parentId) {
          // A subagent never provisions; it rides its root's Sandbox.
          let root: Entry | undefined = entry;
          for (let depth = 0; root?.parentId && depth < 32; depth++) root = entries.get(root.parentId);
          if (!root || root.parentId) {
            throw new Error(`subagent ${id} has no root conversation on this pod; refusing to provision a sandbox for it`);
          }
          if (root.status !== "running") await this.revive(root.id);
          entry.sandbox = root.sandbox;
        } else {
          // A placeholder ref with no namespace means the Sandbox is absent, so create rather than
          // resume.
          const from = entry.sandbox;
          const provisioning = from.namespace
            ? provisioner.resume(from, entry.threadId)
            : provisioner.create(sandboxKey(from.name), entry.threadId);
          if (from.namespace) {
            // Resume keeps the ref, so build the bridge now.
            early = buildBridge(async () => {
              const ref = await provisioning;
              if (!sameRef(ref, from)) {
                throw new Error(`sandbox moved from ${from.namespace}/${from.name} to ${ref.namespace}/${ref.name} while reviving`);
              }
            });
            entry.lastActivityAt = nowMs();
            await requeuePending(entry);
            markQueueable(early);
          }
          try {
            entry.sandbox = await provisioning;
          } catch (err) {
            // Queued runs fail on the gate; next prompt revives afresh.
            if (early && entry.bridge === early) entry.bridge = undefined;
            throw err;
          }
          // The gate fails its runs; rebuild on the real ref.
          if (early && !sameRef(entry.sandbox, from)) {
            if (entry.bridge === early) entry.bridge = undefined;
            early = undefined;
          }
        }
        // end() may have landed during provisioning; destroy the pod just made before any side effect
        // republishes the conversation.
        if (endedIds.has(id)) {
          if (early && entry.bridge === early) entry.bridge = undefined;
          // A subagent's Sandbox is its root's; never destroy it here.
          if (entry.parentId) throw new Error(`conversation was ended: ${id}`);
          await provisioner.destroy(entry.sandbox).catch((err: unknown) => {
            log.errorWith("failed to destroy a pod revived into a deleted conversation", err, {
              conversation_id: id,
            });
          });
          throw new Error(`conversation was ended: ${id}`);
        }
        // A model switch during provisioning drops the early bridge.
        const late = !early || entry.bridge !== early;
        if (late) buildBridge();
        entry.status = "running";
        // Republish sandbox_ref, and this pod as creator_pod since the run now lives here;
        // idempotent, fire-and-forget.
        void conversationRegistry.register(id, {
          model: entry.model, owner: entry.owner, parentId: entry.parentId, sandboxRef: entry.sandbox.name,
          creatorPod: deps.selfPod, // placement hint for the controller
        });
        // Count the resume as activity so the idle sweep gives the fresh pod a full idle window; set
        // directly rather than touch() so no fire-and-forget saveMeta races the awaited write below.
        entry.lastActivityAt = nowMs();
        await saveMeta(entry); // awaited so a persist failure propagates
        if (late) {
          await requeuePending(entry);
          markQueueable(entry.bridge);
        }
        await entry.bridge?.start();
        // Re-raise interrupts the previous pod lost; fire-and-forget.
        if (entry.bridge) {
          try {
            deps.onRevived?.(id);
          } catch (err) {
            log.errorWith("onRevived hook failed", err, { conversation_id: id });
          }
        }
        // Publish phase=Assigned; owner-fenced, fire-and-forget.
        if (ownershipGuard.canWrite(id)) void conversationRegistry.setPhase(id, "Assigned");
        return toConversation(entry);
      })();
      reviving.set(id, run);
      try {
        return await run;
      } finally {
        if (reviving.get(id) === run) reviving.delete(id);
        if (queueable.get(id) === accepting) queueable.delete(id);
      }
    },

    async reviveFromMirror(id, expectedGen) {
      // The controller pushes this on a conversation's new host right after assigning it.

      // A positive "another pod owns it" verdict can be a stale cache, since the controller pushes
      // right after writing host_pod and the row notification can land later: a push whose generation
      // is newer than anything observed is trusted and adopted, while one at or below the observed
      // generation is fenced out loudly.
      if (!ownershipGuard.canWrite(id)) {
        const observed = ownershipGuard.observedGeneration?.(id);
        const pushIsNewer =
          expectedGen > 0 && (observed === undefined || expectedGen > observed);
        if (!pushIsNewer || !ownershipGuard.adoptAssignment) {
          log.warn("reviveFromMirror: fenced out (another pod owns this conversation)", {
            conversation_id: id,
            observed_generation: observed ?? null,
            pushed_generation: expectedGen,
          });
          return; // a genuinely stale push
        }
        ownershipGuard.adoptAssignment(id, expectedGen);
        log.info("reviveFromMirror: push is ahead of the row feed — adopting the assignment", {
          conversation_id: id,
          observed_generation: observed ?? null,
          pushed_generation: expectedGen,
        });
      }

      // Hydrate and revive if not already in memory; the dangling-run settlement below runs either
      // way.
      if (!entries.get(id)) {
        const entry = await hydrateByThread(id as ThreadId);
        if (!entry) {
          // Giving up means nobody completes the conversation's run, so warn.
          log.warn("reviveFromMirror: could not reconstruct the conversation", {
            conversation_id: id,
          });
          return;
        }
        void expectedGen; // enforced by the fence above and the append guard
        await this.revive(id);
      }

      // A conversation reassigned mid-run has an unfinished last run; re-drive it so it completes
      // on this host.
      await this.reconcileDanglingRun(id, expectedGen);
    },

    async reconcileDanglingRun(id, expectedGen) {
      if (danglingReconciles.has(id)) return; // one settlement at a time
      danglingReconciles.add(id);
      try {
        // A run this pod started at this generation is in flight, not stranded; without a gen (lazy
        // adoption) a same-host run is left alone.
        const self = deps.selfPod ? { host: deps.selfPod, gen: expectedGen } : undefined;
        const events = await collectEvents(store.readEvents(id));

        // Close every run left open anywhere in the log, not just at the tail, since a fenced
        // hand-off can bury an orphan under later turns; `self` keeps our own live run out of the
        // sweep.
        const inFlight = danglingRunInfo(events, self)?.runId;
        const orphans = orphanRuns(events, self).filter((o) => o.runId !== inFlight);
        for (const o of orphans) {
          await store.appendEvent(id as SessionId, {
            type: "RUN_FINISHED",
            threadId: o.threadId as never,
            runId: o.runId as never,
            interrupted: true,
            ts: Date.now(),
          });
        }
        if (orphans.length > 0) {
          log.warn("closed runs left open by a hand-off", {
            conversation_id: id,
            closed: orphans.length,
            run_ids: orphans.map((o) => o.runId),
          });
        }

        const dangling = danglingRunInfo(events, self);
        if (!dangling) {
          // Logged so a no-op is distinguishable from the hook not firing.
          log.info("dangling-run check: nothing to settle", {
            conversation_id: id,
            events_seen: events.length,
          });
        }
        if (dangling?.cancelRequested) {
          // The user stopped this run before the old host died, so end it rather than resume it.
          log.info("dangling run was cancelled — terminating, not resuming", {
            conversation_id: id,
            run_id: dangling.runId,
          });
          await store.appendEvent(id as SessionId, {
            type: "RUN_FINISHED",
            threadId: dangling.threadId as never,
            runId: dangling.runId as never,
            cancelled: true,
            ts: Date.now(),
          });
        } else if (dangling && !entries.get(id)?.bridge && (await closeIfSuspended(id, dangling))) {
          // Closed above; a live bridge means it was just revived.
        } else if (dangling) {
          const grace = deps.handoffGraceMs ?? 0;
          if (grace > 0 && dangling.host !== undefined && dangling.host !== deps.selfPod) {
            // The previous owner may still be executing it.
            await new Promise((r) => setTimeout(r, grace));
            if (!(ownershipGuard.owns?.(id) ?? true)) {
              log.info("dangling run: lost ownership during the hand-off grace — not resuming", { conversation_id: id });
              return;
            }
            const after = danglingRunInfo(await collectEvents(store.readEvents(id)), self);
            if (after?.runId !== dangling.runId) {
              log.info("dangling run settled during the hand-off grace — not resuming", { conversation_id: id });
              return;
            }
          }
          log.info("resuming a dangling run", { conversation_id: id, previous_host: dangling.host });
          // source "resume" persists as a UI-hidden SYSTEM_MESSAGE.
          void this.prompt(id, RESUME_NUDGE, undefined, undefined, undefined, undefined, undefined, "resume").catch((err) =>
            log.errorWith("dangling-run resume failed", err, { conversation_id: id }),
          );
        }
      } catch (err) {
        log.errorWith("dangling-run check failed", err, { conversation_id: id });
      } finally {
        danglingReconciles.delete(id);
      }
    },

    async relinquish(id) {
      await reviving.get(id)?.catch(() => {});
      if (ownershipGuard.owns?.(id)) return; // reassigned back meanwhile
      await stopLocalRun(id, "ownership lost");
    },

    async stopFencedRun(id) {
      await stopLocalRun(id, "append refused by the fence");
    },

    async refreshSandbox(id) {
      const entry = entries.get(id);
      // revive()/start() keep a bridged entry's ref current; only a hydrated snapshot goes stale.
      if (!entry || entry.bridge || entry.status === "ended" || !provisioner.reconcile) return;
      const now = nowMs();
      if (now - (lastSandboxRefresh.get(id) ?? 0) < REFRESH_SANDBOX_MS) return;
      lastSandboxRefresh.set(id, now);
      try {
        const found = (await provisioner.reconcile()).find((s) => s.ref.name === entry.sandbox.name);
        if (!found) return; // still absent: keep the placeholder so revive() creates it
        entry.sandbox = found.ref;
        entry.status = found.running ? "running" : "suspended";
      } catch {
        /* keep the snapshot; the next call past the throttle retries */
      }
    },

    async ensureReadable(id) {
      const known = entries.get(id) !== undefined;
      // Read-only: hydrateByThread registers a suspended placeholder without starting the sandbox
      // or bridge.
      if (known) return true;
      const entry = await hydrateByThread(id as ThreadId);
      return entry !== undefined;
    },

    async prompt(id, text, model, priority, interrupt, images, files, source) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      touch(entry);
      const { run } = await inArrivalOrder(entry.threadId, async () => {
        await applyModelSwitch(entry, model);
        // Revive whenever there is no live bridge, since a hydrated conversation can be "running"
        // with no bridge in this process.
        const bridge = await bridgeFor(entry);
        const opts = priority || interrupt ? { priority, interrupt } : undefined;
        const humanInitiated = source !== undefined && DERIVED_SOURCES.has(source) ? await inheritedHumanTrigger(entry) : undefined;
        return { run: bridge?.prompt({ threadId: entry.threadId, text, images, files, source, humanInitiated }, opts) };
      });
      await run;
    },

    async promptByThread(threadId, text, model, priority, owner, images, files, source, provider, sender) {
      const { run } = await queueByThread(threadId, text, model, priority, images, files, source, provider, sender);
      await run;
    },

    async enqueueByThread(threadId, text, source, priority) {
      const { run } = await queueByThread(threadId, text, undefined, priority, undefined, undefined, source);
      // The bridge records a failed run in the conversation itself; nobody awaits this one.
      run?.catch((err: unknown) => log.warn("queued prompt failed", { conversation_id: threadId, error: formatError(err) }));
    },

    async switchModelNow(id, model) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      if (model === entry.model) return false; // already current
      touch(entry);
      // Called mid-turn by the switch_model tool: cancel the in-flight run cleanly, switch the
      // model on the now-idle bridge, then nudge only after the rebuild so the new goose is fully
      // up first.
      await entry.bridge?.cancel().catch(() => {});
      await applyModelSwitch(entry, model, undefined, "agent");
      // source "resume" persists as a UI-hidden SYSTEM_MESSAGE.
      await this.prompt(id, MODEL_SWITCH_NUDGE, undefined, undefined, undefined, undefined, undefined, "resume");
      return true;
    },

    async pendingRestart(id) {
      const entry = entries.get(id);
      if (!entry || entry.status === "ended" || !provisioner.pendingRestart) return undefined;
      const root = rootEntry(entry);
      if (!root.sandbox.namespace) return undefined; // not created yet: it starts on the current image
      return provisioner.pendingRestart(root.sandbox);
    },

    async restartSandbox(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      if (entry.status === "ended") throw new Error(`conversation was ended: ${id}`);
      if (!provisioner.restart) throw new Error("this deployment cannot restart sandboxes");
      const root = rootEntry(entry);
      if (!root.sandbox.namespace) throw new Error("this conversation has no sandbox yet");
      const other = otherBusyOnSandbox(root, id);
      if (other) {
        throw Object.assign(new Error(`conversation ${other.id} is running in this sandbox; restart after it finishes`), { code: 409 });
      }
      touch(root);
      clearDeferredStops(root);
      const wasSuspended = root.status === "suspended";
      const result = await provisioner.restart(root.sandbox, {
        // Claim the row first, or the controller re-suspends it.
        onRunning: () => {
          if (!wasSuspended || !ownershipGuard.canWrite(root.id)) return;
          void (async () => {
            await conversationRegistry.register(root.id, { sandboxRef: root.sandbox.name, creatorPod: deps.selfPod });
            await conversationRegistry.setPhase(root.id, "Assigned");
          })().catch((err) => log.errorWith("restart: publishing the phase failed", err, { conversation_id: root.id }));
        },
      });
      deps.onSandboxCycled?.(root.sandbox);
      // Revive, not just flip status, so a bridge gets built.
      if (root.status === "suspended") await this.revive(root.id);
      return result;
    },

    async stopSandbox(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      if (entry.status === "ended") throw new Error(`conversation was ended: ${id}`);
      const root = rootEntry(entry);
      const other = otherBusyOnSandbox(root, id);
      if (other) {
        throw Object.assign(new Error(`conversation ${other.id} is running in this sandbox; stop after it finishes`), { code: 409 });
      }
      const pending = root.sandbox.namespace ? await provisioner.pendingRestart?.(root.sandbox).catch(() => undefined) : undefined;
      if (root.status !== "running") return { deferred: false, pending };
      if (!busy(entry)) {
        await api.suspend(root.id);
        deps.onSandboxCycled?.(root.sandbox);
        return { deferred: false, pending };
      }
      // Mid-run: stop the pod; suspend when the run ends.
      await provisioner.suspend(root.sandbox);
      deps.onSandboxCycled?.(root.sandbox);
      entry.stopAfterRun = true;
      log.info("stop_sandbox: sandbox stopped mid-run; suspending the conversation when the run ends", {
        conversation_id: id,
        sandbox: root.sandbox.name,
      });
      return { deferred: true, pending };
    },

    noteSandboxResumed(id) {
      const entry = entries.get(id);
      if (!entry) return;
      try {
        clearDeferredStops(rootEntry(entry));
      } catch {
        // No root entry: nothing to clear.
      }
    },

    async suspend(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      // Drain the bridge's in-memory queue onto the entry before dropping the bridge so
      // already-sent messages survive; the optional call keeps a bridge without drainQueue from
      // failing the suspend.
      const drained = entry.bridge?.drainQueue?.() ?? [];
      if (drained.length > 0) {
        entry.pendingQueue = [...(entry.pendingQueue ?? []), ...drained];
        await saveMeta(entry); // durable before the teardown
      }
      await entry.bridge?.stop();
      // A subagent's Sandbox is its parent's, which keeps running.
      if (!entry.parentId) await provisioner.suspend(entry.sandbox);
      entry.bridge = undefined;
      entry.status = "suspended";
      // Publish phase to the row; owner-fenced, fire-and-forget.
      if (ownershipGuard.canWrite(id)) void conversationRegistry.setPhase(id, "Suspended");
    },

    async end(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      // End the whole subtree depth-first; only the root of the end destroys the shared pod.
      const endSubtree = async (targetId: SessionId, destroyPod: boolean): Promise<void> => {
        const e = entries.get(targetId);
        if (!e) return;
        // Tombstone before the teardown's awaits so a concurrent prompt/revive cannot write the
        // conversation back.
        tombstone(targetId);
        // Depth-first: end descendants before this node.
        const children = [...entries.values()].filter((c) => c.parentId === targetId);
        for (const child of children) await endSubtree(child.id, false);
        // The registry is the source of truth for existence, so remove the row BEFORE the pod
        // goes: another replica's exec that then finds no pod must also find no row, or its
        // resume-on-missing-pod recreates the Sandbox (resumeGuard.ts). A Sandbox left behind by
        // a destroy failing after this is unreferenced, which the controller's orphan reap
        // collects. A failure is logged rather than failing the delete.
        await conversationRegistry.remove(targetId).catch((err: unknown) => {
          log.errorWith("failed to remove the conversation from the registry; it may be re-adopted", err, {
            conversation_id: targetId,
          });
        });
        await e.bridge?.stop();
        if (destroyPod) await provisioner.destroy(e.sandbox);
        e.bridge = undefined;
        e.status = "ended";
        wired.delete(targetId);
        // Drop from memory and persisted state so it neither lists nor returns on the next
        // hydrate().
        entries.delete(targetId);
        await store.removeConversation?.(targetId);
      };
      // Only a top-level conversation owns its pod; a subagent shares its ancestor's.
      await endSubtree(id, entry.parentId === undefined);
    },

    get(id) {
      const entry = entries.get(id);
      return entry ? toConversation(entry) : undefined;
    },

    isEnded(id) {
      return endedIds.has(id);
    },

    touchById(id) {
      const entry = entries.get(id);
      const at = nowMs();
      if (store.touchActivity) {
        if (entry) entry.lastActivityAt = Math.max(entry.lastActivityAt, at);
        void store.touchActivity(id, at);
      } else if (entry) {
        touch(entry); // file-only: no shared store, so only the local copy can be bumped
      }
    },

    async getBySandboxKey(key) {
      const name = `conv-${key}`;
      // In-memory first.
      const live = [...entries.values()].filter((e) => !e.parentId && e.sandbox.name === name);
      if (live.length > 1) return ambiguous(key, live.length);
      if (live.length === 1) return toConversation(live[0]);
      // Not in memory: scan the persisted conversations and hydrate the match on demand.
      let metas: ConversationMeta[];
      try {
        metas = (await store.listConversations?.()) ?? [];
      } catch (err) {
        // eslint-disable-next-line no-console
        log.errorWith("getBySandboxKey store lookup failed", err, { sandbox_key: key });
        return undefined;
      }
      // An unrecorded conversation could have either name.
      const matches = metas.filter(
        (x) => !x.parentId && (x.sandboxRef ? x.sandboxRef === name : x.id === key || shortId(x.threadId) === key),
      );
      if (matches.length > 1) return ambiguous(key, matches.length);
      if (matches.length === 0) return undefined;
      const entry = (await hydrateByThread(matches[0].threadId)) ?? entries.get(matches[0].id);
      return entry?.sandbox.name === name ? toConversation(entry) : undefined;
    },

    list() {
      return [...entries.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(toConversation);
    },

    async setTitle(id, title, opts) {
      const entry = entries.get(id);
      if (!entry) return;
      const force = opts?.force === true;
      try {
        await refreshRouterMeta(entry);
      } catch (err) {
        log.warn("router meta read failed; deciding from memory", { conversation_id: id, error: formatError(err) });
      }
      // A user-chosen name is locked against the agent, force or not.
      if (entry.userTitled) return;
      // A conversation is named only once; `force` is the deliberate rename.
      if (!force && !isPlaceholderTitle(entry.title)) return;
      entry.title = title;
      // The durable write drives the live sidebar: the conversations row's trigger fires NOTIFY and
      // the conversation-router pushes the upsert.
      return saveMeta(entry);
    },

    async refreshRouterMeta(id) {
      const entry = entries.get(id);
      if (entry) await refreshRouterMeta(entry);
    },

    async setVisibility(id, visibility) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      if (entry.parentId) throw new Error("a subagent takes its parent's visibility");
      if (visibility === "private" && !entry.owner) throw new Error("a private conversation needs an owner");
      // Durable first, and it throws: a failed write must fail the request, not leave memory saying
      // private while the store (the truth every access check reads) says shared.
      await store.setVisibility?.(id, visibility);
      // The whole tree, since every descendant runs in this conversation's pod.
      const tree = new Set<SessionId>([id]);
      for (let grew = true; grew; ) {
        grew = false;
        for (const e of entries.values()) {
          if (e.parentId && tree.has(e.parentId) && !tree.has(e.id)) {
            tree.add(e.id);
            grew = true;
          }
        }
      }
      for (const t of tree) {
        const e = entries.get(t)!;
        e.visibility = visibility;
        void saveMeta(e); // the file store's only write; Postgres ignores it
      }
    },

    async hydrate() {
      const metas = (await store.listConversations?.()) ?? [];

      // The registry is the source of truth for which conversations this pod serves; list() throws
      // on failure and is left to propagate so a pod that cannot read the truth does not serve a
      // stale view.
      const crs = deps.selfPod ? await conversationRegistry.list() : [];
      // Adopt only what is assigned to us; an unassigned conversation is left to the assigners
      // (router and controller).
      const mine = crs.filter((c) => c.hostPod && c.hostPod === deps.selfPod);
      const metaById = new Map(metas.map((m) => [m.id, m] as const));
      const crById = new Map(crs.map((c) => [c.id, c] as const));
      // Ancestry from meta, else the record, so adoption order does not matter.
      const lineage = (pid: SessionId) => {
        const rec = crById.get(pid);
        return metaById.get(pid) ?? (rec && { threadId: pid as ThreadId, parentId: rec.spec.parentId as SessionId | undefined, sandboxRef: rec.spec.sandboxRef });
      };

      // Reconcile which conv-* Sandboxes exist and whether each pod runs, with retry and backoff to
      // ride out a boot-time apiserver blip; on exhaustion assume all suspended.
      const live = new Map<string, { ref: SandboxRef; running: boolean }>();
      let reconciled = false;
      const RETRIES = 5;
      for (let attempt = 0; attempt < RETRIES; attempt++) {
        try {
          for (const s of (await provisioner.reconcile?.()) ?? []) {
            live.set(s.ref.name, s);
          }
          reconciled = true;
          break;
        } catch (err) {
          if (attempt === RETRIES - 1) {
            // Exhausted retries: assume suspended and log loudly.
            // eslint-disable-next-line no-console
            log.errorWith(
              "hydrate reconcile failed; assuming all suspended (pod-leak risk if persistent)",
              err,
              { attempts: RETRIES },
            );
          } else {
            // Exponential backoff.
            const delay = 250 * 2 ** attempt;
            // eslint-disable-next-line no-console
            log.warn("hydrate reconcile attempt failed; retrying", {
              attempt: attempt + 1,
              attempts: RETRIES,
              retry_in_ms: delay,
              error: formatError(err),
            });
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      // Without a cluster view, keep the legacy name.
      const has = reconciled ? (n: string) => live.has(n) : undefined;

      for (const m of metas) {
        if (entries.has(m.id)) continue; // a live one already exists
        const name = sandboxNameOf(m, lineage, has);
        const entry = hydrateEntry(m, live.get(name), name);
        // Re-publish Suspended so a phase that never landed self-heals here, the one place a pod
        // re-observes a suspended conversation; owner-fenced.
        if (entry.status === "suspended" && ownershipGuard.canWrite(entry.id)) {
          void conversationRegistry.setPhase(entry.id, "Suspended");
        }
      }

      // Adopt the conversations assigned to us that the meta list missed.
      for (const c of mine) {
        if (entries.has(c.id)) continue; // already live or hydrated from the local cache
        // A conversation with no meta is adopted from the registry record alone, enough to be
        // listed, suspended and reclaimed.
        const meta = metaById.get(c.id);
        const synthesized: ConversationMeta = meta ?? {
          id: c.id,
          threadId: c.id,
          title: "",
          createdAt: nowMs(),
          lastActivityAt: nowMs(),
          // status lives on Entry, derived by hydrateEntry() from the reconcile result
          model: c.spec.model,
          owner: c.spec.owner,
          parentId: c.spec.parentId,
          visibility: c.spec.visibility,
          ...(c.spec.sandboxRef ? { sandboxRef: c.spec.sandboxRef } : {}),
        };
        // The record is authoritative over a possibly stale meta.
        if (c.spec.owner) synthesized.owner = c.spec.owner;
        if (c.spec.model) synthesized.model = c.spec.model;
        if (c.spec.visibility) synthesized.visibility = c.spec.visibility;
        // Key the reconcile result by the record's sandboxRef when it has one.
        const sandboxName = synthesized.parentId
          ? sandboxNameOf(synthesized, lineage)
          : (c.spec.sandboxRef ?? rootSandboxName(synthesized, has));
        const entry = hydrateEntry(synthesized, live.get(sandboxName), sandboxName);
        entries.set(c.id, entry);
      }
    },

    async resumeInterrupted(opts) {
      const concurrency = Math.max(1, opts?.concurrency ?? 3);
      // Find conversations whose last run is dangling.
      const candidates: SessionId[] = [];
      for (const entry of entries.values()) {
        if (entry.status === "ended") continue;
        // Another pod's conversation: resuming it here would run it twice.
        if (ownershipGuard.observedGeneration?.(entry.id) !== undefined && !ownershipGuard.owns?.(entry.id)) continue;
        try {
          const events = await collectEvents(store.readEvents(entry.id));
          // No `self`: at boot every RUN_STARTED in the log predates this process, even one stamped
          // with our own pod name.
          const info = danglingRunInfo(events);
          if (info?.cancelRequested) {
            // Stopped by the user before the previous process died, so end it rather than redo it.
            log.info("resumeInterrupted: dangling run was cancelled — terminating", {
              conversation_id: entry.id,
              run_id: info.runId,
            });
            await store.appendEvent(entry.id, {
              type: "RUN_FINISHED",
              threadId: info.threadId as never,
              runId: info.runId as never,
              cancelled: true,
              ts: Date.now(),
            });
          } else if (info && !(await closeIfSuspended(entry.id, info))) {
            candidates.push(entry.id);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          log.errorWith("resumeInterrupted: reading the log failed, skipping", err, {
            conversation_id: entry.id,
          });
        }
      }
      if (candidates.length === 0) return [];
      // eslint-disable-next-line no-console
      log.info("resuming interrupted conversations after restart", { count: candidates.length });

      // Bounded concurrency so a cold start does not spawn every goose at once.
      const resumed: SessionId[] = [];
      const queue = [...candidates];
      const worker = async () => {
        for (;;) {
          const id = queue.shift();
          if (!id) return;
          try {
            // source "resume" persists as a UI-hidden SYSTEM_MESSAGE.
            await this.prompt(id, RESUME_NUDGE, undefined, undefined, undefined, undefined, undefined, "resume");
            resumed.push(id);
          } catch (err) {
            // eslint-disable-next-line no-console
            log.errorWith("resumeInterrupted: resume failed", err, { conversation_id: id });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
      return resumed;
    },

    async sweepIdle(idleMs, now = nowMs()) {
      const suspended: SessionId[] = [];
      // A conversation with a running descendant must not be swept, since its subagents share the
      // pod. A suspended child does not pin it: reviving the child revives its root first.
      const hasLiveDescendant = (id: SessionId): boolean => {
        for (const c of entries.values()) {
          if (c.parentId !== id) continue;
          if (c.status === "running") return true; // a live child
          if (hasLiveDescendant(c.id)) return true; // ...or a live grandchild
        }
        return false;
      };
      for (const entry of entries.values()) {
        if (entry.status !== "running") continue;
        // Positive owner only: the job probe resumes a missing pod, so probing a conversation deleted
        // elsewhere (canWrite fails open once its row is gone) recreates its sandbox as a zombie.
        if (!(ownershipGuard.owns?.(entry.id) ?? ownershipGuard.canWrite(entry.id))) continue;
        if (now - entry.lastActivityAt < idleMs) continue;
        // Another replica may have recorded activity this one never saw (a proxied WebSocket
        // bound to the replica it connected through), so re-check the shared value; a failed
        // read falls back to the local one.
        const persisted = await store.readLastActivity?.(entry.id).catch(() => undefined);
        if (persisted !== undefined && persisted > entry.lastActivityAt) entry.lastActivityAt = persisted;
        if (now - entry.lastActivityAt < idleMs) continue;
        if (hasLiveDescendant(entry.id)) continue; // keep the shared pod up
        // A running or queued run is not idle, however long ago lastActivityAt was bumped at the
        // prompt boundary.
        const qs = entry.bridge?.queueState();
        if (qs && (qs.running || qs.queued > 0)) continue;
        // A running background job is not idle either; the probe fails open so an error cannot pin
        // the pod up forever.
        // The cache trails the row by a notification; confirm against the row before the probe.
        if (ownershipGuard.confirmOwns && !(await ownershipGuard.confirmOwns(entry.id))) continue;
        if (deps.hasRunningBackgroundJob) {
          let jobRunning = false;
          try {
            jobRunning = await deps.hasRunningBackgroundJob(entry.id);
          } catch (err) {
            log.errorWith("background-job check failed; suspending anyway", err, {
              conversation_id: entry.id,
            });
          }
          if (jobRunning) continue;
        }
        try {
          await this.suspend(entry.id);
          suspended.push(entry.id);
        } catch (err) {
          // Logged so a chronically unsuspendable conversation is visible.
          // eslint-disable-next-line no-console
          log.errorWith("idle-suspend failed; will retry next sweep", err, { conversation_id: entry.id });
        }
      }
      return suspended;
    },

    async sweepRetention(maxAgeMs, now = nowMs()) {
      const reaped: SessionId[] = [];
      // Same shared-pod guard as sweepIdle; subagents are reaped with their parent via end()'s
      // cascade.
      const hasLiveDescendant = (id: SessionId): boolean => {
        for (const c of entries.values()) {
          if (c.parentId !== id) continue;
          if (c.status !== "ended") return true;
          if (hasLiveDescendant(c.id)) return true;
        }
        return false;
      };
      // Snapshot first, since end() mutates `entries`.
      const idle = [...entries.values()].filter((entry) => {
        if (entry.parentId !== undefined) return false; // subagents die with their parent
        if (entry.starred) return false; // starred = exempt
        if (now - entry.lastActivityAt < HOUR_MS) return false; // under the shortest lifetime
        if (hasLiveDescendant(entry.id)) return false; // keep the shared pod
        // Never reap a conversation with a live or queued run, since end() is destructive.
        const qs = entry.bridge?.queueState();
        if (qs && (qs.running || qs.queued > 0)) return false;
        return true;
      });
      // Throws on a failed read, so "forever" is never ignored.
      const lifetimes =
        idle.length && store.readLifetimes ? await store.readLifetimes(idle.map((e) => e.id)) : new Map<SessionId, number>();
      const candidates = idle.filter((entry) => {
        const hours = lifetimes.get(entry.id);
        const limit = hours === undefined ? maxAgeMs : hours * HOUR_MS;
        return limit > 0 && now - entry.lastActivityAt >= limit;
      });
      for (const entry of candidates) {
        try {
          // The router stars without telling this replica.
          await refreshRouterMeta(entry);
          if (entry.starred) continue;
          await this.end(entry.id);
          reaped.push(entry.id);
        } catch (err) {
          // Logged so a conversation that can never be reaped is visible.
          // eslint-disable-next-line no-console
          log.errorWith("retention reap failed; will retry next sweep", err, { conversation_id: entry.id });
        }
      }
      return reaped;
    },

    onSubagentComplete(cb) {
      subagentCompleteSubs.add(cb);
      return () => subagentCompleteSubs.delete(cb);
    },
  };
  return api;
}

const HOUR_MS = 3_600_000;

/** Wall-clock ms, wrapped so it is mockable. */
function nowMs(): number {
  return Date.now();
}
