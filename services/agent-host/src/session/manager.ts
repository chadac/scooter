/**
 * Session manager — owns conversation lifecycle in the agent-host.
 *
 * Topology-agnostic: hosts N sessions (N goose processes) per host pod now;
 * one-per-pod later is a deployment change, not an interface change.
 *
 * Per conversation it ties together:
 *   - a Sandbox (cold, per-conversation SA + 2 PVCs)        -> provisioner
 *   - a goose acp process + ACP<->AG-UI bridge              -> SessionBridge
 *   - the conversation-state PVC (goose state + event log)  -> store
 *   - the AG-UI connection(s) to the browser                -> AguiServer
 */

import type { SessionId, ThreadId, SandboxRef } from "../types.js";
import type { JobRecord } from "./jobManager.js";
import type { SessionBridge, AguiEvent, InterruptPolicy, PromptImage, PromptFile } from "../bridge.js";
import { danglingRunInfo, orphanRuns } from "./danglingRun.js";
import { allowAllGuard, type OwnershipGuard } from "./ownershipGuard.js";
import { noopRegistry, type ConversationRegistry } from "./conversationRegistry.js";
import { formatError, logger } from "../log.js";

const log = logger("manager");

/** The synthetic prompt sent to resume a run interrupted by an agent-host restart.
 *  Not the user's literal prompt (which would re-do work / double-post): a nudge
 *  to continue, leaning on the bridge's history reinjection for context. */
const RESUME_NUDGE =
  "[System: this conversation was interrupted by a restart while you were working. " +
  "Continue where you left off — do NOT restart the task, re-introduce yourself, or " +
  "repeat a message/comment you already posted. If you had already finished, a brief " +
  "status is fine.]";

/** The synthetic prompt sent after an agent-initiated model switch (switch_model):
 *  the current turn was cancelled to swap the model, so nudge the agent to pick its
 *  own work back up on the new model — without redoing or re-announcing anything. */
const MODEL_SWITCH_NUDGE =
  "[System: your model was switched at your request; the previous turn was ended to " +
  "apply it. Continue where you left off on the new model — do NOT restart the task, " +
  "re-introduce yourself, or repeat anything you already did or posted.]";

/** An event plus the rolling integrity checksum through it. `prevChecksum` is
 *  the chain value before this event (so a client links each event to the one
 *  before); `checksum` is the value through and including it. */
export interface ChecksummedEvent {
  event: AguiEvent;
  prevChecksum: string;
  checksum: string;
}

/** Provisions / suspends / resumes the per-conversation Sandbox. */
export interface SandboxProvisioner {
  /** Cold-create a Sandbox: SA sandbox-{id}, workspace + conversation PVCs.
   *  `conversationId` is the SHORT, DNS-1123-safe id used for k8s resource NAMES.
   *  `threadId` is the FULL conversation id the UI deep-links on (`?thread=<id>`) —
   *  used to build the sandbox's CONVERSATION_URL so the agent shares a link that
   *  actually resolves to THIS conversation (not the short hash). Defaults to
   *  `conversationId` when omitted (local/legacy). */
  create(conversationId: string, threadId?: string): Promise<SandboxRef>;
  /** operatingMode: Suspended (drops Pod, keeps PVCs + Sandbox object). */
  suspend(ref: SandboxRef): Promise<void>;
  /** operatingMode: Running (recreates Pod, re-mounts PVCs, same SA). */
  resume(ref: SandboxRef, threadId?: string): Promise<SandboxRef>;
  /** Delete the Sandbox + GC the per-conversation SA/RBAC. */
  destroy(ref: SandboxRef): Promise<void>;
  /** List the live per-conversation Sandboxes (name -> ref + whether its pod is
   *  currently running, i.e. replicas>0). Used by hydrate() after a restart to
   *  reconcile in-memory status against reality, so a Sandbox whose pod is STILL
   *  running (never actually suspended) is tracked as running and the idle sweep
   *  can reclaim it — instead of being assumed-suspended and leaking forever.
   *  Optional: provisioners that can't enumerate return undefined. */
  reconcile?(): Promise<Array<{ ref: SandboxRef; running: boolean }>>;
}

/** Durable, restart-surviving metadata for one conversation. */
export interface ConversationMeta {
  id: SessionId;
  threadId: ThreadId;
  title: string;
  createdAt: number;
  lastActivityAt: number;
  /** Per-conversation model override (undefined = host default). Persisted so a
   *  mid-conversation model switch survives an agent-host restart. */
  model?: string;
  /** Creating user (ingress identity). undefined = unowned/public. Persisted for
   *  the "my conversations" view filter (survives restart). */
  owner?: string;
  /** The SPAWNING conversation, when this is a subagent. undefined = a top-level
   *  conversation. A subagent shares its parent's sandbox pod; the whole tree
   *  shares one root pod (see spawnChild). Persisted so the hierarchy survives an
   *  agent-host restart. */
  parentId?: SessionId;
  /** The user renamed this conversation, so `title` is USER-set and locked: the
   *  agent's <title> marker no longer overwrites it (setTitle becomes a no-op).
   *  undefined/false = still agent-titled (the agent may set/update the title). */
  userTitled?: boolean;
  /** The user starred this conversation. Surfaced in the UI and (in a future
   *  retention reaper) exempts it from auto-deletion. Hibernation is unaffected —
   *  a starred conversation still idle-suspends. */
  starred?: boolean;
  /** Messages that were still QUEUED in the bridge when the conversation was
   *  suspended. The run queue lives in the bridge closure, which suspend() drops —
   *  so without persisting them here the user's already-sent message is destroyed
   *  silently (it never runs and never errors). revive() re-enqueues these on the
   *  rebuilt bridge and clears the field. */
  pendingQueue?: Array<{ text: string; priority: number }>;
}

/** An external resource a conversation is linked to (a GitHub PR/issue, GitLab
 *  MR, Slack thread, Jira ticket) — pushed by the webhooks service and shown in
 *  the UI's linked-resources panel. */
export interface ConversationLink {
  /** "github" | "gitlab" | "slack" | "jira" | … (drives the icon). */
  source: string;
  /** "pull_request" | "issue" | "merge_request" | "thread" | "ticket" | … */
  resourceType: string;
  /** A clickable URL to the resource (when known). */
  url?: string;
  /** A short human label (e.g. "example-org/example-app #203", "#eng-help thread"). */
  title?: string;
  /**
   * Structured target identifiers for the agent-tools (slack_respond,
   * gitlab_comment, github_comment, jira_comment) to INFER where to respond
   * WITHOUT the agent passing them. Populated by the webhooks handlers in
   * push_link. Shapes by source (all optional so old links / partial data degrade
   * to an explicit-target request, never a wrong guess):
   *   slack:  { channel, threadTs }
   *   gitlab: { projectId, mrIid }
   *   github: { owner, repo, number }
   *   jira:   { issueKey }
   */
  ref?: {
    channel?: string;
    threadTs?: string;
    projectId?: string;
    mrIid?: string;
    owner?: string;
    repo?: string;
    number?: number;
    issueKey?: string;
  };
}

/** Durable conversation store (event log replay + goose state pointer). */
export interface ConversationStore {
  appendEvent(id: SessionId, event: AguiEvent): Promise<void>;
  /** Await all appends ENQUEUED so far for `id` to be durably written. appendEvent
   *  is fired-and-forget (`void store.appendEvent(...)`), so a reader that runs right
   *  after an event was EMITTED can read a log that doesn't yet include it — the
   *  subagent-completion race: a subagent's RUN_FINISHED fires onEvent (→ report
   *  completion → readEvents) BEFORE the fire-and-forget append flushes, so
   *  lastRunCompleted() sees no finish and the notification is dropped. Awaiting
   *  flush(id) before reading closes that window. Optional: in-memory test stores
   *  whose appendEvent is synchronous have nothing pending, so this is a no-op. */
  flush?(id: SessionId): Promise<void>;
  readEvents(id: SessionId): AsyncIterable<AguiEvent>;
  /** Like readEvents, but each item carries the rolling integrity checksum
   *  through that event (and the previous one) so a streaming client can verify
   *  the chain. Computed deterministically from the persisted log order, so it
   *  survives a restart. Optional (in-memory test stores may skip it). */
  readEventsWithChecksum?(id: SessionId): AsyncIterable<ChecksummedEvent>;
  /** REPLACE a conversation's entire event log with `events` (atomic rewrite), resetting the rolling
   *  integrity checksum. Used ONLY by content-based reconciliation when the
   *  log has DIVERGED from the store (a fork, not a prefix) — the store wins, so local
   *  is rewritten to it. NOT a hot-path operation. Optional (in-memory test stores may skip it). */
  replaceEvents?(id: SessionId, events: AguiEvent[]): Promise<void>;
  /** The RECENT tail only: the events from the last `runs` runs, read WITHOUT
   *  parsing the whole log (scan from the end for RUN_STARTED boundaries) — so a
   *  fast first-paint window on a long conversation stays cheap. Optional (an
   *  in-memory store can fall back to reading all of readEvents). */
  readEventsTail?(id: SessionId, runs: number): Promise<AguiEvent[]>;
  /** The last `limit` events by seq — a size-bounded first-paint window. Optional. */
  readEventsTailByCount?(id: SessionId, limit: number): Promise<AguiEvent[]>;
  readEventsBefore?(
    id: SessionId,
    beforeSeq: number,
    limit: number,
  ): Promise<{ events: AguiEvent[]; firstSeq: number; done: boolean }>;
  /** Subscribe to events as they are durably appended, each carrying its rolling
   *  checksum (folded in persisted order). This is the authority the live
   *  integrity stream broadcasts — it sees EVERY logged event (incl. the user's
   *  own prompt), exactly once, in order. Returns an unsubscribe fn. Optional. */
  onAppend?(cb: (id: SessionId, event: ChecksummedEvent) => void): () => void;
  /** Subscribe to durable-append FAILURES (finding #4). appendEvent is usually
   *  fire-and-forget, so a failed write to the conversation's only persistence
   *  would otherwise vanish silently — this surfaces it for logging/metrics.
   *  Returns an unsubscribe fn. Optional. */
  onAppendError?(cb: (id: SessionId, error: unknown) => void): () => void;
  /** Path on the conversation-state PVC where goose session data lives. */
  gooseStatePath(id: SessionId): string;
  /** Persist conversation metadata (title/createdAt/lastActivityAt) so the list
   *  survives an agent-host restart. The sole persistence path for lastActivityAt —
   *  touch() routes through it. Optional (in-memory stores skip it). */
  saveMeta?(meta: ConversationMeta): Promise<void>;
  /** Reconstruct all persisted conversations (for the list after a restart).
   *  Optional. */
  listConversations?(): Promise<ConversationMeta[]>;
  /** Permanently remove a conversation's persisted state so an ended/deleted
   *  conversation does not reappear on the next hydrate(). Optional. */
  removeConversation?(id: SessionId): Promise<void>;
  /** Record an external resource link for a conversation (deduped). Optional. */
  addLink?(id: SessionId, link: ConversationLink): Promise<void>;
  /** The conversation's external resource links (for the UI panel). Optional. */
  listLinks?(id: SessionId): Promise<ConversationLink[]>;
  /** Append a background-job record (run_background). The durable registry so
   *  list_background survives an agent-host restart. Optional. */
  saveJob?(id: SessionId, job: JobRecord): Promise<void>;
  /** The conversation's background-job records (newest first; [] if none). */
  listJobs?(id: SessionId): Promise<JobRecord[]>;
  /** Update a job record in place (by jobId), e.g. to mark notifiedAt. Optional. */
  updateJob?(id: SessionId, job: JobRecord): Promise<void>;
}

/**
 * A prompt arrived for a conversation that does not exist. The agent-host does not
 * create one implicitly — conversations are created by the conversation-router
 * (see services/conversation-router/create.go), so a caller-chosen id can never
 * become a conversation id, an event-log key, or a k8s resource name.
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
  /** ms epoch of the last prompt or agent event. Drives idle-suspend. */
  readonly lastActivityAt: number;
  /** Model this conversation runs on (undefined = the host default). */
  readonly model?: string;
  /** The user who created it (the ingress identity). undefined = unowned/public
   *  (e.g. pre-migration or webhook-spawned). Drives the "my conversations" view
   *  filter — NOT an access boundary (conversations are public). */
  readonly owner?: string;
  /** The spawning conversation, when this is a subagent. undefined = top-level.
   *  A subagent shares its parent's sandbox; find a conversation's children by
   *  scanning for `parentId === id`. */
  readonly parentId?: SessionId;
  /** The title is USER-set (renamed) and locked against the agent's <title>. */
  readonly userTitled?: boolean;
  /** The user starred it (UI highlight + future retention exemption). */
  readonly starred?: boolean;
}

export interface SessionManager {
  /** Start a brand-new conversation (cold Sandbox + goose + PVCs). `model`
   *  selects the agent model (validated by the caller); `owner` is the creating
   *  user (the ingress identity) recorded for the view filter. */
  start(threadId: ThreadId, model?: string, owner?: string): Promise<Conversation>;
  /** Spawn a SUBAGENT: a new conversation that SHARES the parent's sandbox pod
   *  (no new provisioning) and carries `parentId`. Inherits the parent's owner
   *  (so cost + the view filter attribute to the same user). The child gets its
   *  own bridge/goose session (its own scratch cwd) execing into the parent's
   *  pod. `childThreadId` is the child's id/thread. Throws if the parent is
   *  unknown. Multi-level: a subagent may itself spawnChild (still the root pod). */
  spawnChild(
    parentId: SessionId,
    childThreadId: ThreadId,
    args: { prompt: string; title?: string; model?: string },
  ): Promise<Conversation>;
  /** Subscribe to subagent completions: fired (subagentId, parentId) the moment a
   *  subagent's run FINISHES (its bridge emits RUN_FINISHED/RUN_ERROR) — event-
   *  driven, so the parent gets the result immediately instead of on the next poll.
   *  The host wires this to inject the child's result into the parent + clean it up.
   *  Returns an unsubscribe. A RUN_FINISHED with outcome "interrupt" (a pause
   *  awaiting a user answer) is NOT a completion and does not fire. */
  onSubagentComplete(cb: (subagentId: SessionId, parentId: SessionId) => void): () => void;
  /** Re-attach to / revive a suspended conversation (resume + replay log). Assumes the
   *  conversation is known to THIS pod (durable state present locally). */
  revive(id: SessionId): Promise<Conversation>;
  /** REVIVE-ON-ASSIGN (seamless rollout): revive a conversation that may be UNKNOWN to this
   *  pod (this pod is its NEW owner after
   *  a rollout reassignment). Idempotent (no-op if already in memory). `expectedGen` is the
   *  CR's current generation for fencing — revive only if this pod is the current owner at
   *  that generation; a stale push (older gen) is a no-op. Distinct from `revive()`, which
   *  404s when the conversation isn't already local. DESIGN STUB — see
   *  todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md. */
  reviveFromMirror(id: SessionId, expectedGen: number): Promise<void>;
  /** Settle a conversation's DANGLING last run on this pod: terminate it (persisted
   *  cancel intent) or resume-nudge it. Owner-fenced by callers; idempotent-guarded
   *  (one reconciliation in flight per conversation). Runs from reviveFromMirror
   *  (the revive push) AND ensureReadable's adoption (the LAZY path — the push is
   *  fire-and-forget by design, and when it is lost with a dying pod the adopted
   *  conversation otherwise keeps its stranded run forever: the pod-move story's
   *  'Working…' that never cleared). */
  reconcileDanglingRun(id: SessionId, expectedGen?: number): Promise<void>;
  /** READ-ONLY hydrate for a reconnecting UI: make a conversation's history available on
   *  THIS pod so the read routes (events / events.integrity) can serve it, WITHOUT starting
   *  the sandbox/bridge (unlike revive*).
   *  then registers the entry as a suspended placeholder. Returns true if the conversation
   *  exists — false ⇒ genuinely unknown (404). Cheap
   *  + idempotent; the route calls it before deciding to 404. See ROLLOUT_DRAIN_AND_POD_IP.md
   *  (the "GET after a pod move / deleted CR" 404 gap). */
  ensureReadable(id: SessionId): Promise<boolean>;
  /** Forward a user prompt into the conversation's goose session. An optional
   *  `model` switches the conversation's model: if it differs from the current
   *  one, the live goose session is rebuilt with the new model. `priority`
   *  (PRIORITY_INTERRUPT) lets an @mention force-interrupt a running turn after the
   *  bridge's priority timeout; normal prompts (default) wait their turn. */
  prompt(id: SessionId, text: string, model?: string, priority?: number, interrupt?: InterruptPolicy, images?: PromptImage[], files?: PromptFile[], source?: string): Promise<void>;
  /** Find-or-start the conversation for an AG-UI thread, then prompt it. A
   *  `model` on the FIRST prompt picks the conversation's model; on a later
   *  prompt it switches it (rebuilds the goose session). `priority` as in prompt().
   *  `owner` stamps the conversation's owner when it's newly STARTED here (a
   *  webhook-resolved Scooter user) — ignored for an already-existing conversation.
   *  `images` are attached uploads (resolved to ACP image blocks by the bridge).
   *  `files` are binary attachments (Slack) the bridge writes to /workspace/.slack. */
  promptByThread(threadId: ThreadId, text: string, model?: string, priority?: number, owner?: string, images?: PromptImage[], files?: PromptFile[], source?: string): Promise<void>;
  /** Switch a RUNNING conversation's model IMMEDIATELY and continue its work on
   *  the new model. Unlike a model passed to prompt() (which applies on the next
   *  turn), this is for the switch_model MCP tool the agent calls MID-TURN: it
   *  cancels the in-flight run (so the tool's own run ends cleanly), rebuilds goose
   *  with the new model, and re-nudges to continue where it left off. A no-op if
   *  `model` is already current. Throws on an unknown conversation. Returns whether
   *  a switch happened. */
  switchModelNow(id: SessionId, model: string): Promise<boolean>;
  suspend(id: SessionId): Promise<void>;
  end(id: SessionId): Promise<void>;

  get(id: SessionId): Conversation | undefined;
  /** Resolve a conversation by its SHORT DNS-safe hash (the `shortId(threadId)`
   *  used for k8s resource names). The broker identifies a conversation by this
   *  short id (extracted from the sandbox SA name `sandbox-{shortId}`), NOT the
   *  full threadId the session map is keyed by — so the aws-request route must
   *  resolve via this, else `get(shortId)` misses and the approval 404s. May
   *  hydrate a persisted-but-not-in-memory conversation. Returns undefined only
   *  when no conversation has that short id. */
  getByShortId(shortHash: string): Promise<Conversation | undefined>;
  /** Mark a conversation active NOW (bump lastActivityAt + persist), so the idle
   *  sweep won't suspend it. For NON-agent activity that should still count as "in
   *  use" — e.g. a user connected to the conversation's in-pod web services
   *  (vscode/marimo/terminal) through the reverse proxy. No-op if the conversation
   *  isn't in memory (nothing to keep alive). */
  touchById(id: SessionId): void;
  /** All conversations, newest first. */
  list(): Conversation[];
  /** Set a conversation's title (e.g. agent-assigned). */
  /** Set a conversation's title FROM THE AGENT (the <title> marker) and persist it.
   *  A NO-OP once the user has renamed the conversation (userTitled) — the user's
   *  title wins permanently. Returns the persist promise so a caller can await
   *  durability; fire-and-forget callers may ignore it. */
  setTitle(id: SessionId, title: string): Promise<void>;
  /** Rename FROM THE USER: sets the title AND locks it (userTitled=true) so the
   *  agent's <title> marker can no longer overwrite it. Returns the persist promise. */
  setUserTitle(id: SessionId, title: string): Promise<void>;
  /** Star / unstar a conversation (persisted; surfaced in the UI + future retention
   *  exemption). Returns the persist promise. */
  setStarred(id: SessionId, starred: boolean): Promise<void>;
  /** Load persisted conversations from the store into the in-memory list, so
   *  the session list (and GET /conversations) survives an agent-host restart.
   *  Persisted-but-not-live conversations come back as "suspended". */
  hydrate(): Promise<void>;
  /**
   * Resume conversations INTERRUPTED by an agent-host restart: a run that started
   * but never finished (the process died mid-run). For each, revive the bridge
   * (spawns goose, reinjects history) and send a synthetic "continue where you
   * left off" nudge — so the work resumes on its own without re-running the user's
   * literal prompt. Call after hydrate() on boot. Bounded concurrency so a cold
   * start with many interrupted conversations doesn't thundering-herd. Returns the
   * ids resumed. Best-effort: a per-conversation failure is logged, not fatal.
   */
  resumeInterrupted(opts?: { concurrency?: number }): Promise<SessionId[]>;
  /**
   * Suspend conversations that have been idle (no prompt/event) longer than
   * idleMs. Native-friendly: the agent-host owns the activity signal, so it
   * does this itself; the activity metadata is exposed so an external
   * controller could take over. Returns the ids suspended.
   */
  sweepIdle(idleMs: number, now?: number): Promise<SessionId[]>;

  /**
   * RETENTION REAP: END (destroy pod + PVCs + record) top-level conversations that
   * have been INACTIVE longer than maxAgeMs — the autonomous cleanup of stale
   * conversations. EXEMPTS starred conversations (the whole point of the star flag)
   * and any with a live descendant (the shared pod). Age is measured from
   * lastActivityAt (a recently-used conversation is never old, however long ago it
   * was created). Subagents (parentId set) are reaped with their parent, not on their
   * own. Returns the ids reaped. Unlike sweepIdle (suspend), this is DESTRUCTIVE.
   */
  sweepRetention(maxAgeMs: number, now?: number): Promise<SessionId[]>;
}

/** Builds the ACP<->AG-UI bridge for a conversation (spawns goose in prod). */
export type BridgeFactory = (args: {
  conversationId: SessionId;
  sandbox: SandboxRef;
  /** Per-conversation model override (undefined = host default). */
  model?: string;
  /** The conversation OWNER — passed to the bridge's per-run ACP provider resolver so an
   *  owner-bound provider (the BYO remote agent) can route this conversation to that user's
   *  agent. Undefined for an unowned/anonymous conversation. */
  owner?: string;
}) => SessionBridge | undefined;

export interface SessionManagerDeps {
  provisioner: SandboxProvisioner;
  store: ConversationStore;
  /** Optional multi-replica FENCING guard: before this pod appends to a conversation's
   *  log, canWrite() checks it still owns the conversation (Conversation CR hostPod/
   *  generation). Omitted / allowAllGuard = single-replica (always allow, today's
   *  behavior). See ownershipGuard.ts. */
  ownershipGuard?: OwnershipGuard;
  /** Optional multi-replica registry: on start()/spawnChild() this writes a Conversation
   *  CR so the controller can assign the conversation a hostPod and the router forwards to
   *  it. Omitted / noopRegistry = single-replica (no CR). See conversationRegistry.ts. */
  conversationRegistry?: ConversationRegistry;
  /** This pod's name (POD_NAME). Multi-replica only. When set together with a registry that can
   *  list(), hydrate() becomes CR-DRIVEN: it adopts every Conversation the CONTROLLER assigned to
   *  this pod (`status.hostPod === selfPod`), instead of replaying the ephemeral local store.
   *  Omitted single-replica, where there are no CRs and the local store is the only source. */
  selfPod?: string;
  /** Optional: how to build a bridge per conversation. Omitted in unit tests
   *  that only assert lifecycle/provisioning. */
  bridgeFactory?: BridgeFactory;
  /** Optional: called after a conversation's bridge is (re)built by revive() — with
   *  a live bridge. index.ts uses it to re-raise approval interrupts a pod rollout
   *  dropped: the interrupt's in-memory answer-routing is lost on restart, but the
   *  request still sits PENDING in the broker (source of truth), so on revive we
   *  re-query + re-raise. Fire-and-forget; a failure must not fail the revive. */
  onRevived?: (id: SessionId) => void;
  /** Optional: does this conversation have a RUNNING background job (run_background)?
   *  Consulted by sweepIdle so a long-running detached in-pod job isn't SIGTERM'd by an
   *  idle-suspend (lastActivityAt isn't bumped while a job runs). Wired to the jobManager in
   *  index.ts; omitted when jobs are disabled. Best-effort: a throw/absence fails OPEN (the
   *  sweep still suspends) — a job probe must never pin a pod up forever on an error. */
  hasRunningBackgroundJob?: (id: SessionId) => Promise<boolean>;
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
  owner?: string;
  parentId?: SessionId;
  userTitled?: boolean;
  starred?: boolean;
  /** Messages still QUEUED in the bridge when this conversation was suspended, so
   *  revive() can re-enqueue them (the bridge closure that held them is gone). */
  pendingQueue?: Array<{ text: string; priority: number }>;
}

/** Drain an async iterable of events into an array (fallback for stores without
 *  readEventsTail — in-memory test stores, whose logs are tiny). */
async function collectEvents(it: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** Short, DNS-1123-safe id derived from a (possibly UUID) thread id. Exported so
 *  callers keying broker-side per-conversation state (e.g. the size spec) use the
 *  SAME short id ensure/resume/create key sandboxes under. */
export function shortId(threadId: string): string {
  let h = 0;
  for (let i = 0; i < threadId.length; i++) h = (h * 31 + threadId.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { provisioner, store, bridgeFactory } = deps;
  const ownershipGuard = deps.ownershipGuard ?? allowAllGuard;
  const conversationRegistry = deps.conversationRegistry ?? noopRegistry;
  const entries = new Map<SessionId, Entry>();

  // Subagent-completion subscribers (see onSubagentComplete). Fired event-driven
  // when a subagent's bridge emits a terminal RUN_FINISHED/RUN_ERROR.
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
    owner: e.owner,
    parentId: e.parentId,
    userTitled: e.userTitled,
    starred: e.starred,
  });

  // Mark the conversation active NOW and persist it. Fire-and-forget: touch() runs on
  // the prompt path and on throttled web-service proxy traffic, so it must never block
  // either. (`saveMeta` is declared below; touch is only CALLED after init completes.)
  const touch = (e: Entry) => {
    e.lastActivityAt = nowMs();
    void saveMeta(e);
  };

  // Build an in-memory Entry from a persisted meta (no bridge; revive() spawns
  // goose on first use). `onCluster` is the reconcile result for this conversation's
  // Sandbox (running pod -> track RUNNING with its real ref; else a suspended
  // placeholder that revive() recreates). Shared by hydrate() (bulk, at startup)
  // and hydrateByThread() (on-demand, when a prompt arrives for an id not yet in
  // the map — e.g. hydrate raced or failed). Returns the Entry.
  const hydrateEntry = (m: ConversationMeta, onCluster?: { ref: SandboxRef; running: boolean }): Entry => {
    const name = `conv-${shortId(m.threadId)}`;
    const entry: Entry = {
      id: m.id,
      threadId: m.threadId,
      // Keep the real ref (with namespace) for ANY Sandbox that EXISTS on the
      // cluster — running OR suspended — so revive() resume()s it. Only when the
      // Sandbox is absent from reconcile (onCluster undefined: GC'd / never made)
      // do we use the empty-namespace placeholder that revive() reads as
      // "create from scratch". (A suspended-but-present Sandbox resumed via
      // create() 409s AlreadyExists — the bug this distinction fixes.)
      sandbox: onCluster ? onCluster.ref : { name, namespace: "" },
      bridge: undefined,
      status: onCluster?.running ? "running" : "suspended",
      title: m.title,
      createdAt: m.createdAt,
      lastActivityAt: m.lastActivityAt,
      model: m.model,
      owner: m.owner,
      parentId: m.parentId,
      userTitled: m.userTitled,
      starred: m.starred,
      pendingQueue: m.pendingQueue,
    };
    entries.set(m.id, entry);
    return entry;
  };

  // On-demand hydration for a single thread: if a conversation with `threadId`
  // exists in the STORE but not in the in-memory map, reconstruct its Entry so a
  // follow-up prompt CONTINUES it instead of blind-creating a duplicate (which
  // orphans the persisted event log). Returns the Entry, or undefined if the store
  // has no such conversation (a genuinely new thread). Best-effort: a store error
  // returns undefined (caller falls back to creating), logged so it's observable.
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
    if (!m) {
      // No local meta. The conversation may still EXIST as a Conversation CR that this
      // pod has not cached yet — the router creates the CR and returns immediately, so a
      // prompt can arrive before any store write. The CR is authoritative for existence,
      // so adopt from it (same synthesis hydrate() uses to adopt at boot).
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
      };
      // Publish sandboxRef NOW, not after revive() finishes provisioning. The router
      // derives the routing short-id from spec.sandboxRef, so a conversation adopted
      // here would otherwise be unroutable for the whole sandbox boot (minutes on a
      // cold node). start() registers it up front for exactly this reason; adoption
      // has to match. register() is idempotent and never throws.
      if (!c.spec.sandboxRef) {
        void conversationRegistry.register(c.id, {
          model: c.spec.model,
          owner: c.spec.owner,
          parentId: c.spec.parentId,
          sandboxRef: `conv-${shortId(c.id)}`,
          creatorPod: deps.selfPod, // the run lives HERE — placement hint for the controller
        });
      }
    }
    if (entries.has(m.id)) return entries.get(m.id);
    // Reconcile just this conversation's Sandbox so we track a still-running pod
    // correctly (best-effort; on failure revive() recreates from the placeholder).
    let onCluster: { ref: SandboxRef; running: boolean } | undefined;
    try {
      const name = `conv-${shortId(m.threadId)}`;
      onCluster = (await provisioner.reconcile?.())?.find((s) => s.ref.name === name);
    } catch {
      /* reconcile failed — treat as suspended; revive() recreates the pod */
    }
    const hydrated = hydrateEntry(m, onCluster);
    // LAZY dangling-run settlement, on EVERY adoption path. The first version hung
    // this off ensureReadable only — and the pod-move repro adopted through a
    // DIFFERENT hydrateByThread caller, so the stranded run still spun for the full
    // budget with the fix deployed. Whatever route materializes a conversation on
    // its new owner, the stranded-run settlement must ride along. Owner-fenced;
    // fire-and-forget; the in-flight guard dedupes overlapping callers.
    if (hydrated && ownershipGuard.canWrite(hydrated.id)) {
      void api.reconcileDanglingRun(hydrated.id);
    }
    return hydrated;
  };

  // Returns the persist promise so callers that must guarantee durability (e.g.
  // start(), before returning to the caller) can await it; fire-and-forget
  // callers (setTitle) just ignore it.
  const saveMeta = (e: Entry): Promise<void> =>
    store.saveMeta?.({
      id: e.id,
      threadId: e.threadId,
      title: e.title,
      createdAt: e.createdAt,
      lastActivityAt: e.lastActivityAt,
      model: e.model,
      owner: e.owner,
      parentId: e.parentId,
      userTitled: e.userTitled,
      starred: e.starred,
      pendingQueue: e.pendingQueue,
    }) ?? Promise.resolve();

  /** Events dropped by the ownership fence, per conversation — for sampled logging only. */
  const fencedDrops = new Map<SessionId, number>();
  /** Dangling-run reconciliations in flight — reviveFromMirror and the lazy adoption
   *  path can race on the same conversation; one settles it, the other no-ops. */
  const danglingReconciles = new Set<SessionId>();
  const wireEventLog = (e: Entry) => {
    if (!e.bridge) return;
    // Persist via the onPersist channel ONLY. The bridge's emit() fires BOTH the
    // broadcast (onEvent) and persist (onPersist) listener sets, and persist-only
    // events (the user's own prompt) fire onPersist alone — so onPersist sees
    // EVERY event that should be logged, exactly once. Subscribing to onEvent too
    // would double-log every broadcast event (bloated, replay-confusing history).
    e.bridge.onPersist((event) => {
      e.lastActivityAt = nowMs();
      // FENCING: if a reassignment made another pod the owner, this (stale) pod must
      // stop appending so it can't corrupt the log the new owner drives. Synchronous +
      // cache-backed (no k8s call per event). allowAllGuard (single-replica) always
      // passes — today's behavior. See ownershipGuard.ts.
      if (!ownershipGuard.canWrite(e.id)) {
        // LOUD, because this drop is how a mid-run reassignment TRUNCATES the run's log:
        // every remaining event — including the terminal — vanishes, and the UI reads the
        // log as still-running forever. The drop itself is correct (a stale pod must not
        // corrupt the log the new owner drives; the new owner's dangling-run resume
        // completes the run), but it was SILENT — an investigation grepped for fencing
        // refusals and found zero, concluding the fence never fired. It had, every time.
        // Sampled: first drop per conversation, then every 25th, so a long stale run
        // cannot flood the log.
        const n = (fencedDrops.get(e.id) ?? 0) + 1;
        fencedDrops.set(e.id, n);
        if (n === 1 || n % 25 === 0) {
          log.warn("ownership fence dropped an event (reassigned mid-run?)", {
            conversation_id: e.id,
            event_type: event.type,
            dropped_so_far: n,
          });
        }
        return;
      }
      // NOT bare `void`: the store RETHROWS append failures after logging them
      // (finding #4), and `void promise` leaves that rejection unhandled — which
      // KILLS the Node process. A late event racing the conversation's deletion
      // (cleanState, a reassignment's aftermath) made ENOENT here take down the
      // whole agent-host mid-suite: 11 e2e-fast tests died to one stale append.
      // The store already logged + notified observers; swallowing here loses nothing.
      store.appendEvent(e.id, event).catch(() => {});
    });
  };

  /** Switch a conversation's model. A no-op when `model` is undefined or already
   *  the current one. Otherwise updates entry.model, tears down the live bridge
   *  (so goose is relaunched with the new GOOSE_MODEL on the next prompt's
   *  revive), and persists the change so a restart keeps it.
   *
   *  The old goose's teardown is FIRE-AND-FORGET: bridge.stop() awaits the old
   *  process's exit (so it doesn't linger), which can take a couple seconds — but
   *  we must NOT block the NEXT prompt on it, or the model switch adds that latency
   *  before turn 2 even starts (it stacked with slow CI to push the reply past the
   *  e2e's timeout — the model-switch flake). The new goose spawns immediately with
   *  the new GOOSE_MODEL; the old one dies in the background. They briefly share the
   *  per-conversation cwd (goose sessions DB), which is safe — the new bridge does a
   *  fresh newSession (distinct session row) and SQLite tolerates the overlap. */
  const applyModelSwitch = async (e: Entry, model?: string): Promise<void> => {
    if (model === undefined || model === e.model) return;
    e.model = model;
    if (e.bridge) {
      const old = e.bridge;
      e.bridge = undefined; // prompt()/promptByThread revive -> rebuild with e.model
      // Fire-and-forget: don't block the next prompt on the old goose's exit.
      void old.stop().catch(() => {});
    }
    await saveMeta(e);
  };

  const api: SessionManager = {
    async start(threadId, model, owner) {
      // The conversation id IS the thread id, so AG-UI events broadcast/persist
      // under the same key the UI subscribes by. The sandbox (k8s) name uses a
      // short DNS-safe hash of it.
      const id: SessionId = threadId;
      // REGISTER THE ENTRY FIRST — before the (slow) sandbox provisioning below.
      // The UI POSTs /agui then IMMEDIATELY opens GET .../events.integrity; if the
      // entry isn't in `entries` yet, that route 404s ("unknown conversation") and
      // the UI gives up reconnecting → a new chat looks broken. So the conversation
      // must be visible from the moment start() begins. The sandbox + bridge are
      // filled in after provisioning; the integrity stream just waits for events.
      const entry: Entry = {
        id, threadId, sandbox: { name: `conv-${shortId(threadId)}`, namespace: "" },
        bridge: undefined, status: "running",
        title: "New chat", createdAt: nowMs(), lastActivityAt: nowMs(), model, owner,
      };
      entries.set(id, entry);
      await saveMeta(entry);

      // Register the assignment-table CR so the controller assigns a hostPod and the
      // router forwards subsequent requests here. Idempotent + non-throwing (a k8s
      // failure must not fail the conversation); noop in single-replica mode. Do it
      // BEFORE the slow provision so assignment can happen while the sandbox spins up.
      await conversationRegistry.register(id, { model, owner, sandboxRef: entry.sandbox.name, creatorPod: deps.selfPod });

      // Now provision the sandbox (seconds) and attach the bridge. Short hash → k8s
      // resource names; full threadId → the shareable CONVERSATION_URL (?thread=<id>).
      entry.sandbox = await provisioner.create(shortId(threadId), threadId);
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model, owner: entry.owner });
      wireEventLog(entry); // wire AFTER the bridge exists (it no-ops on a null bridge)
      // Re-persist with the real sandbox ref (a crash mid-provision must not leave a
      // dangling entry with no namespace that revive() then can't resume).
      await saveMeta(entry);
      // NOTE: do NOT eagerly bridge.start() here — that spawns goose and blocks
      // on its ACP newSession. bridge.prompt() lazily starts on first use, after
      // emitting RUN_STARTED, so the UI always sees the run begin.
      return toConversation(entry);
    },

    async spawnChild(parentId, childThreadId, args) {
      const parent = entries.get(parentId);
      if (!parent) throw new Error(`unknown parent conversation: ${parentId}`);
      const id: SessionId = childThreadId;
      // A subagent SHARES the parent's sandbox pod (the whole tree shares one root
      // pod — a subagent's own spawnChild reuses the same ref again). It inherits
      // the parent's owner (cost + view filter) and carries parentId. Its bridge
      // execs into the PARENT's pod but has its own goose session (own scratch cwd,
      // keyed by the child id in the bridge factory).
      const model = args.model ?? parent.model;
      const entry: Entry = {
        id,
        threadId: childThreadId,
        sandbox: parent.sandbox, // REUSE — no provisioner.create
        bridge: undefined,
        status: "running",
        title: args.title ?? "Subagent",
        createdAt: nowMs(),
        lastActivityAt: nowMs(),
        model,
        owner: parent.owner,
        parentId,
      };
      entries.set(id, entry);
      await saveMeta(entry);

      // Register the child CR carrying parentId so the controller CO-LOCATES it on the
      // parent's pod (it shares the parent's sandbox). Idempotent + non-throwing; noop in
      // single-replica mode.
      await conversationRegistry.register(id, {
        model, owner: parent.owner, parentId, sandboxRef: entry.sandbox.name,
        creatorPod: deps.selfPod, // the run lives HERE — placement hint for the controller
      });

      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model, owner: entry.owner });
      wireEventLog(entry);
      // Event-driven completion: fire onSubagentComplete the instant this
      // subagent's run terminates, so the host injects the result into the parent
      // immediately (no poll-interval latency). A RUN_FINISHED with outcome
      // "interrupt" is a PAUSE awaiting a user answer — not a completion — so skip
      // it; a real finish (no outcome, or "error") fires once per completion.
      entry.bridge?.onEvent((event) => {
        const done =
          (event.type === "RUN_FINISHED" && event.outcome?.type !== "interrupt") || event.type === "RUN_ERROR";
        if (done) emitSubagentComplete(id, parentId);
      });
      await saveMeta(entry);

      // Kick off the subagent's work. Bias it toward a useful final message (the
      // last-message result convention — matches the Claude CLI: the subagent's
      // final message returns to the parent). Lazy bridge.start on first prompt.
      const framedPrompt =
        `${args.prompt}\n\n` +
        `---\n(You are a subagent. Do the task above, then END your turn with a ` +
        `concise summary of what you found or did — that final message is returned ` +
        `to the agent that spawned you.)`;
      await entry.bridge?.prompt({ threadId: childThreadId, text: framedPrompt });
      return toConversation(entry);
    },

    async revive(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);

      // A HYDRATED conversation (restored from disk after a restart) has a
      // placeholder sandbox ref with no namespace — its pod was never created in
      // THIS process (and a suspended Sandbox may have been GC'd). Re-create the
      // sandbox rather than resume a ref this process never owned.
      entry.sandbox = entry.sandbox.namespace
        ? await provisioner.resume(entry.sandbox, entry.threadId)
        : await provisioner.create(shortId(entry.threadId), entry.threadId);
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model: entry.model, owner: entry.owner }) ?? entry.bridge;
      entry.status = "running";
      // RE-REGISTER the CR on revive. register() is only called on start()/spawnChild(), so a
      // conversation revived after a restart/rollout (or hydrated on a lazy prompt) whose CR was
      // never created / was lost would run CR-less — invisible to `kubectl get conversations`
      // AND unroutable (no hostPod, so it only works via the router's fallback). register() is
      // idempotent (409 = already there = no-op), so this is a cheap self-heal. Fire-and-forget.
      void conversationRegistry.register(id, {
        model: entry.model, owner: entry.owner, parentId: entry.parentId, sandboxRef: entry.sandbox.name,
        creatorPod: deps.selfPod, // the run lives HERE — placement hint for the controller
      });
      // Register the resume as ACTIVITY. Without this, lastActivityAt stays at its
      // pre-suspend value, so the idle sweep (sweepIdle) sees the conversation as
      // already-idle and re-suspends the pod we JUST started — a UI "Start sandbox"
      // (or any prompt-less revive) would die within one sweep interval. touch()
      // gives the freshly-started pod the full idle window before it can be reclaimed.
      touch(entry);
      wireEventLog(entry);
      await saveMeta(entry); // await (like start/create) so a persist failure propagates, not an unhandled rejection
      await entry.bridge?.start();
      // Event-log replay to a reattaching UI is driven by the AG-UI server's
      // onAttach handler reading store.readEvents(id); nothing to do here.
      // Re-raise any interrupts the (now-live) bridge lost on the previous pod (a
      // rollout drops the in-memory interrupt state). Fire-and-forget — a broker
      // hiccup here must not fail the revive that just brought the pod back.
      if (entry.bridge) {
        try {
          deps.onRevived?.(id);
        } catch (err) {
          log.errorWith("onRevived hook failed", err, { conversation_id: id });
        }
      }
      // RE-ENQUEUE anything that was still queued when this conversation was suspended.
      // suspend() drained the bridge's in-memory queue onto the entry (and persisted it)
      // precisely so the user's already-sent message is not destroyed by the teardown.
      // Clear the field FIRST so a failure below can't replay the same message twice on
      // the next revive, and persist the cleared state before running them.
      let pending = entry.pendingQueue ?? [];
      if (pending.length > 0) {
        // DEDUPE against the durable log before replaying. runPrompt persists the user
        // message BEFORE calling the agent, so a message that was IN FLIGHT when the
        // suspend landed is already in the log — replaying it blindly would show it (and
        // answer it) twice, and repeat any side effects its interrupted run had started.
        // The log is the authority here (it survives restarts and is the same thing the
        // UI renders), which is why this lives in the agent-host rather than in each
        // caller. Only messages NOT already logged are replayed; a message that never
        // started is absent from the log and still runs, which is the case that matters.
        try {
          const tail = (await store.readEventsTail?.(id, 3)) ?? (await collectEvents(store.readEvents(id)));
          // Match ONLY user turns. TEXT_MESSAGE_CONTENT carries no role (only
          // TEXT_MESSAGE_START does), and the ASSISTANT's reply is streamed as
          // TEXT_MESSAGE_CONTENT too — so matching deltas blindly would let an
          // assistant message that happens to quote the text suppress a legitimate
          // replay (the fake agent literally echoes the user's words back). Track the
          // messageIds opened with role:"user" and only collect deltas for those.
          const userMsgIds = new Set<string>();
          const loggedUserTexts = new Set<string>();
          for (const e of tail) {
            const ev = e as { type?: string; delta?: string; role?: string; messageId?: string };
            if (ev.type === "TEXT_MESSAGE_START" && ev.role === "user" && ev.messageId) {
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
          // A read failure must not block the revive. Replaying is the safer default:
          // a possible duplicate turn beats silently dropping the user's message.
          log.errorWith("revive: replay dedupe read failed, replaying all", err, { conversation_id: id });
        }
      }
      if (pending.length > 0 || (entry.pendingQueue?.length ?? 0) > 0) {
        entry.pendingQueue = [];
        await saveMeta(entry);
        for (const item of pending) {
          // Fire-and-forget with a catch: a queued message that fails to re-run must not
          // fail the revive that just brought the pod back (the RUN_ERROR is persisted by
          // the bridge/prompt path and surfaces in the conversation).
          void entry.bridge
            ?.prompt(
              { threadId: entry.threadId, text: item.text },
              item.priority ? { priority: item.priority } : undefined,
            )
            .catch((err) => {
              log.errorWith("re-enqueued message failed", err, { conversation_id: id });
            });
        }
      }
      // Back to alive: publish phase=Assigned so a suspended→resumed conversation reflects
      // in `kubectl get conversations`. Owner-fenced, fire-and-forget (see suspend()).
      if (ownershipGuard.canWrite(id)) void conversationRegistry.setPhase(id, "Assigned");
      return toConversation(entry);
    },

    async reviveFromMirror(id, expectedGen) {
      // REVIVE-ON-ASSIGN (seamless rollout): the controller pushes this on a conversation's
      // NEW host right after (re)assigning it. See todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md.

      // FENCE: only revive if this pod is the current owner at `expectedGen`. canWrite()
      // fails OPEN when unobserved (the CR watch may lag the push), which is safe — a
      // genuinely stale push still can't advance the log (append is fenced too), and
      // reviving a conversation we don't own is a harmless read+resume that the next
      // reconcile corrects. But a POSITIVE "another pod owns it" verdict needs one more
      // look: the controller POSTs this push IMMEDIATELY after writing hostPod=<us> at
      // `expectedGen`, and the watch event for that same write routinely lands AFTER
      // the push — so the cache can still name the PREVIOUS owner. That is a stale
      // CACHE, not a stale push, and nothing ever re-pushes: dropping it left the
      // reassigned mid-run conversation dangling forever ("Working…" until the e2e
      // budget died — the conversation-moves-pods story). When the
      // push's generation is NEWER than anything the watch has shown, trust the push,
      // adopt the assignment (the watch confirms or corrects it shortly), and proceed.
      // A push at or below the observed generation IS stale: keep the fence — loudly,
      // never silently (the silent drop cost this exact investigation).
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
          return; // fenced out — a genuinely stale push.
        }
        ownershipGuard.adoptAssignment(id, expectedGen);
        log.info("reviveFromMirror: push is ahead of the CR watch — adopting the assignment", {
          conversation_id: id,
          observed_generation: observed ?? null,
          pushed_generation: expectedGen,
        });
      }

      // If NOT already live here, hydrate
      // the Entry (hydrateByThread reads the now-local meta), and revive it. If it's ALREADY
      // in memory this is a no-op — but we STILL run the dangling-run resume below (a
      // conversation reassigned mid-run may already be revived yet have an unfinished run).
      if (!entries.get(id)) {
        const entry = await hydrateByThread(id as ThreadId);
        if (!entry) {
          // LOUD: this pod was ASSIGNED the conversation, so giving up means nobody
          // completes its (possibly truncated) run — "Working… forever".
          log.warn("reviveFromMirror: could not reconstruct the conversation", {
            conversation_id: id,
          });
          return;
        }
        void expectedGen; // gen already enforced via the fence above + the append guard.
        await this.revive(id);
      }

      // Whether we just revived it or it was already live: if the conversation was reassigned
      // MID-RUN (its last run started but never emitted RUN_FINISHED — the old pod drained
      // before the model finished), re-drive it so the run completes on this host. Without
      // this the UI is stuck "thinking" forever. Same mechanism boot uses (resumeInterrupted),
      // for the one conversation. Fire-and-forget — a nudge failure is logged, not fatal.
      await this.reconcileDanglingRun(id, expectedGen);
    },

    async reconcileDanglingRun(id, expectedGen) {
      if (danglingReconciles.has(id)) return; // one settlement at a time
      danglingReconciles.add(id);
      try {
        // Pass our identity: a run THIS pod started at THIS generation is in flight, not
        // stranded. `expectedGen` is the generation the controller assigned us at — a run
        // stamped with an earlier one was left by a previous assignment and still resumes.
        // With no gen (the lazy adoption path) a same-host run reads as OWN and is left
        // alone — conservative: adoption implies the entry was not in memory, so a live
        // own run cannot be the one we would touch.
        const self = deps.selfPod ? { host: deps.selfPod, gen: expectedGen } : undefined;
        const events = await collectEvents(store.readEvents(id));

        // HEAL FIRST: close any run left open ANYWHERE in the log, not just at the
        // tail. A fenced hand-off drops the outgoing pod's remaining events —
        // terminal included — and the next turn completes on top, burying the
        // orphan where the tail-only check can never reach it. The UI's `running`
        // flag is a boolean, so one stray RUN_STARTED reads as "working" forever.
        //
        // Safe to write here: this pod was just assigned the conversation, the
        // controller keeps a single hostPod, and the fence stops the old owner — so
        // nobody else can be driving these runs. The run that is genuinely in
        // flight (if any) is excluded below.
        const inFlight = danglingRunInfo(events, self)?.runId;
        const orphans = orphanRuns(events).filter((o) => o.runId !== inFlight);
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
          // NEVER silent: a wrong no-op here is indistinguishable from the hook not
          // firing at all, which cost three deploy-validate rounds to see.
          log.info("dangling-run check: nothing to settle", {
            conversation_id: id,
            events_seen: events.length,
          });
        }
        if (dangling?.cancelRequested) {
          // The user STOPPED this run before the old host died (the persisted
          // CANCEL_REQUESTED marker). Resuming it would resurrect work the user
          // killed; instead END it the way the old host would have — the reconnected
          // stream replays this terminal and the UI's run bar finally clears.
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
        } else if (dangling) {
          log.info("resuming a dangling run", { conversation_id: id });
          // source "resume" → persists as a SYSTEM_MESSAGE (platform-injected, not a
          // role:user turn) which the UI hides — the nudge is internal, not a user message.
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

    async ensureReadable(id) {
      // In memory != history is here: hydrate loads META only, so a known conversation
      // still takes the pull (a no-op once the log is local). PR #405.
      const known = entries.get(id) !== undefined;
      // Hydrate it if
      // configured — so a reconnecting UI (GET events / events.integrity) can read history
      // even after the owner pod moved (rollout) or the CR was cleared. READ-ONLY: no
      // sandbox/bridge spin-up (unlike revive*). hydrateByThread then registers the entry as
      // a suspended placeholder; the next prompt revives the pod on demand.
      if (known) return true;
      const entry = await hydrateByThread(id as ThreadId);
      return entry !== undefined;
    },

    async prompt(id, text, model, priority, interrupt, images, files, source) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      touch(entry);
      await applyModelSwitch(entry, model);
      // Revive whenever there's no LIVE bridge (goose process), not just when the
      // status is non-running: a HYDRATED conversation can be status "running"
      // (its pod is up, per hydrate's reconcile) yet have no bridge in THIS
      // process, so the prompt would silently no-op (bridge?.prompt on undefined).
      if (!entry.bridge) await this.revive(id);
      const opts = priority || interrupt ? { priority, interrupt } : undefined;
      await entry.bridge?.prompt({ threadId: entry.threadId, text, images, files, source }, opts);
    },

    async promptByThread(threadId, text, model, priority, owner, images, files, source) {
      // Find the conversation for this thread. Three cases:
      //  1. in the in-memory map -> use it (revive if no live bridge).
      //  2. NOT in the map but PERSISTED (store has it) -> hydrate it on demand and
      //     revive. CRITICAL after an agent-host restart: hydrate() may have raced,
      //     failed, or evicted the id, and a webhook follow-up must CONTINUE the
      //     existing conversation — NOT blind-create a duplicate that orphans the
      //     persisted event log (the restart-orphan bug).
      //  3. genuinely new thread (not in map, not in store) -> start one (the first
      //     prompt's model picks the conversation's model).
      let entry = [...entries.values()].find((e) => e.threadId === threadId);
      if (!entry) {
        entry = await hydrateByThread(threadId);
      }
      if (!entry) {
        // Not in memory, not persisted -> it does not exist. Callers create
        // explicitly (POST /conversations on the router) and prompt the id returned.
        throw new UnknownConversationError(threadId);
      } else {
        await applyModelSwitch(entry, model);
        if (!entry.bridge) {
          // No live bridge -> revive (start goose). Covers suspended, hydrated-but-
          // "running" (pod up, no goose in this process), AND just-hydrated-on-demand
          // conversations.
          await this.revive(entry.id);
        }
      }
      touch(entry);
      // A priority prompt is a webhook @mention to an ACTIVE conversation (the only
      // priority source). Preempt with the "thinking" policy: interrupt idle text
      // generation right away, but let an IN-FLIGHT TOOL CALL finish first — don't
      // kill a running build/exec just to deliver a mention. (Without an explicit
      // policy the bridge defaults to "timeout", which HARD-cancels after the timer,
      // killing the tool call.) The bridge defers a "thinking" cancel while
      // inFlightTools > 0 and fires it at the next tool boundary.
      await entry.bridge?.prompt(
        { threadId, text, images, files, source },
        priority ? { priority, interrupt: "thinking" } : undefined,
      );
    },

    async switchModelNow(id, model) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      if (model === entry.model) return false; // already on it — no-op
      touch(entry);
      // Called MID-TURN by the switch_model tool (goose is running). We must NOT
      // just tear the bridge down under the live run (applyModelSwitch's next-prompt
      // model does that, which would strand the run that invoked the tool). Instead:
      //   1. CANCEL the in-flight run cleanly (RUN_FINISHED cancelled, kills the
      //      active tool call) — the tool's own turn ends here.
      //   2. applyModelSwitch: set entry.model + tear down the (now-idle) bridge +
      //      persist.
      //   3. prompt() with the continue-nudge: revives -> rebuilds goose with the
      //      new GOOSE_MODEL -> continues the work. Strictly AFTER the rebuild, so
      //      this can't reintroduce the model-switch-midconvo race (the new goose is
      //      fully up before the nudge is sent).
      await entry.bridge?.cancel().catch(() => {});
      await applyModelSwitch(entry, model);
      // source "resume" → SYSTEM_MESSAGE (UI-hidden): a model-switch nudge is internal too.
      await this.prompt(id, MODEL_SWITCH_NUDGE, undefined, undefined, undefined, undefined, undefined, "resume");
      return true;
    },

    async suspend(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      // PRESERVE THE QUEUE. The run queue lives in the bridge's closure, which we are
      // about to drop — anything still queued would be destroyed, so the message the
      // user already sent would silently never run and never error (the reported
      // "my message disappears / sits in the queue tab forever"). Drain it FIRST and
      // persist it on the entry; revive() re-enqueues it on the rebuilt bridge.
      // drainQueue also emits the clearing QUEUE_UPDATED, so the durable log's last
      // word on the queue is "empty" and no phantom row survives.
      // Optional-call: a bridge that predates drainQueue (or a partial test double)
      // must not break suspend — losing the queue is bad, failing the suspend is worse
      // (the pod would never come down and the idle sweep would retry forever).
      const drained = entry.bridge?.drainQueue?.() ?? [];
      if (drained.length > 0) {
        entry.pendingQueue = [...(entry.pendingQueue ?? []), ...drained];
        await saveMeta(entry); // durable BEFORE the teardown — a crash here must not lose it
      }
      await entry.bridge?.stop();
      await provisioner.suspend(entry.sandbox);
      entry.bridge = undefined;
      entry.status = "suspended";
      // Publish liveness to the CR (kubectl-observable) — only when we OWN the conversation
      // (a non-owner must not stomp phase). Fire-and-forget; a failed publish just lags the
      // view. See conversationRegistry.setPhase + ROLLOUT/lifecycle docs.
      if (ownershipGuard.canWrite(id)) void conversationRegistry.setPhase(id, "Suspended");
    },

    async end(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      // CASCADE-END the whole subtree first (recursively). Subagents share this
      // conversation's sandbox pod, so ending a child must NOT destroy the shared
      // pod — only THIS (the subtree root of the end) destroys it, once.
      const endSubtree = async (targetId: SessionId, destroyPod: boolean): Promise<void> => {
        const e = entries.get(targetId);
        if (!e) return;
        // Depth-first: end descendants before this node.
        const children = [...entries.values()].filter((c) => c.parentId === targetId);
        for (const child of children) await endSubtree(child.id, false);
        await e.bridge?.stop();
        if (destroyPod) await provisioner.destroy(e.sandbox);
        e.bridge = undefined;
        e.status = "ended";
        // Delete-don't-tombstone: drop from memory + persisted state so it neither
        // shows in GET /conversations nor returns on the next hydrate(). (Suspend,
        // not end, is the durable handle.)
        entries.delete(targetId);
        await store.removeConversation?.(targetId);
        // DELETE THE CR TOO. It is the source of truth for existence, so clearing local
        // state alone is not enough: hydrate() re-adopts a surviving CR and the
        // conversation comes back. Observed on a real cluster — DELETE answered 204 and
        // the conversation stayed listed as `running` indefinitely.
        // Swallow: the local delete already succeeded and is authoritative for the
        // caller. A surviving CR is a leak to reconcile, not a reason to answer 500 for
        // a conversation that IS gone — that would tell the caller nothing true and
        // invite a retry that 404s.
        await conversationRegistry.remove(targetId).catch((err: unknown) => {
          log.errorWith("failed to remove the Conversation CR; it may be re-adopted", err, {
            conversation_id: targetId,
          });
        });
      };
      // Destroy the pod once — for the conversation actually being ended. (If `id`
      // is itself a subagent, it shares its ancestor's pod; ending it should NOT
      // tear that pod down. Only destroy when this conversation has no parent, i.e.
      // it owns its pod.)
      await endSubtree(id, entry.parentId === undefined);
    },

    get(id) {
      const entry = entries.get(id);
      return entry ? toConversation(entry) : undefined;
    },

    touchById(id) {
      const entry = entries.get(id);
      if (entry) touch(entry); // no-op if not in memory — nothing to keep alive
    },

    async getByShortId(shortHash) {
      // In-memory first: match any live entry whose threadId hashes to shortHash.
      const live = [...entries.values()].find((e) => shortId(e.threadId) === shortHash);
      if (live) return toConversation(live);
      // Not in memory (idle-suspended out, or not yet hydrated after a restart):
      // scan the persisted conversations and hydrate the match on demand, so the
      // aws-request route can revive it. Mirrors hydrateByThread's find, keyed by
      // the short hash instead of the full threadId.
      let metas: ConversationMeta[];
      try {
        metas = (await store.listConversations?.()) ?? [];
      } catch (err) {
        // eslint-disable-next-line no-console
        log.errorWith("getByShortId store lookup failed", err, { short_id: shortHash });
        return undefined;
      }
      const m = metas.find((x) => shortId(x.threadId) === shortHash);
      if (!m) return undefined;
      const entry = (await hydrateByThread(m.threadId)) ?? entries.get(m.id);
      return entry ? toConversation(entry) : undefined;
    },

    list() {
      return [...entries.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(toConversation);
    },

    setTitle(id, title) {
      const entry = entries.get(id);
      if (!entry) return Promise.resolve();
      // The agent's <title> marker must NOT clobber a user-chosen name. Once the user
      // has renamed the conversation, the user title is locked (see setUserTitle).
      if (entry.userTitled) return Promise.resolve();
      entry.title = title;
      // The durable write is what drives the live sidebar now: saveMeta updates the
      // conversations row, whose trigger fires NOTIFY 'conversations_changed' and the
      // conversation-router pushes the upsert (see migration 20260902183131 + events.go).
      return saveMeta(entry);
    },

    setUserTitle(id, title) {
      const entry = entries.get(id);
      if (!entry) return Promise.resolve();
      entry.title = title;
      entry.userTitled = true; // lock it: the agent's <title> no longer wins
      return saveMeta(entry);
    },

    setStarred(id, starred) {
      const entry = entries.get(id);
      if (!entry) return Promise.resolve();
      entry.starred = starred;
      return saveMeta(entry);
    },

    async hydrate() {
      const metas = (await store.listConversations?.()) ?? [];

      // THE SOURCE OF TRUTH. `metas` above is the LOCAL cache (LOCAL_STATE_PATH — an emptyDir in
      // cluster, so empty on every boot). The authoritative answer to "which conversations does
      // this pod serve?" is the Conversation CR, which is durable and controller-assigned.
      // Driving hydration off the cache is what left 21 running Sandboxes unknown to every host:
      // no entry means sweepIdle()/resumeInterrupted() (both iterating `entries`) never see them.
      // See docs/CONVERSATION_STATE_MODEL.md.
      //
      // list() THROWS on failure by contract, and we let it propagate: a pod that cannot read the
      // truth must not serve on a stale view (decision Q4). index.ts retries with backoff and
      // fails startup readiness rather than serving blind. Single-replica uses noopRegistry, whose
      // list() is [] — so this is a no-op there and the local path below is unchanged.
      const crs = deps.selfPod ? await conversationRegistry.list() : [];
      // Adopt ONLY what the controller assigned to us. An UNASSIGNED CR (hostPod unset, or naming
      // a pod that no longer exists) is deliberately left alone: the controller is the single
      // assigner and self-claiming would race its load accounting (decision Q1).
      const mine = crs.filter((c) => c.hostPod && c.hostPod === deps.selfPod);
      const metaById = new Map(metas.map((m) => [m.id, m] as const));

      // Reconcile against the cluster: which conv-* Sandboxes actually exist, and
      // is each one's pod still running? A restart loses the in-memory map but the
      // pods may NOT have been suspended — without this we'd assume-suspend them
      // and the idle sweep would never reclaim them (a pod leak).
      // Reconcile with RETRY + backoff. A transient boot-time apiserver blip (EKS
      // 429 "storage is (re)initializing", a connection reset) used to fail the
      // reconcile ONCE, fall back to "assume all suspended", and serve FOREVER with
      // an empty map — so every prompt took the create path and 409'd on an existing
      // Sandbox (the hydrate-silent-drop outage). Retrying rides out the blip so the
      // map is CORRECT. If it STILL fails after the retries, we fall back (+ the 409-
      // reuse in create() is the backstop, and re-hydrate self-heals).
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
            // Exhausted retries — fall back (assume-suspended). The 409-reuse in
            // create() recovers a wrong map per-prompt; a periodic re-hydrate would
            // self-heal fully (a follow-up). Log loudly so it's observable.
            // eslint-disable-next-line no-console
            log.errorWith(
              "hydrate reconcile failed; assuming all suspended (pod-leak risk if persistent)",
              err,
              { attempts: RETRIES },
            );
          } else {
            // Exponential backoff (250ms, 500, 1s, 2s) to ride out a boot blip.
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
      void reconciled; // (kept for readability; the fallback path already logged)

      for (const m of metas) {
        if (entries.has(m.id)) continue; // a live one already exists
        const name = `conv-${shortId(m.threadId)}`;
        const entry = hydrateEntry(m, live.get(name));
        // RE-REGISTER the CR on boot so EVERY persisted conversation is observable + routable,
        // not just ones that get prompted again. register() is only otherwise called on
        // start()/spawnChild()/revive() — a conversation that predates CR registration, or whose
        // CR was lost, would be invisible until its next revive. Idempotent (409 = no-op),
        // fire-and-forget; the controller (re)assigns the CR a host on its next reconcile.
        void conversationRegistry.register(entry.id, {
          model: entry.model, owner: entry.owner, parentId: entry.parentId, sandboxRef: entry.sandbox.name,
          creatorPod: deps.selfPod, // the run lives HERE — placement hint for the controller
        });
        // RE-PUBLISH PHASE for a conversation hydrated as SUSPENDED. phase is otherwise only
        // written at the suspend()/revive() TRANSITION events — so a conversation that was
        // suspended but whose setPhase never landed (e.g. the historical RBAC 403, or the pod
        // died before publishing) stays phase=Assigned/Pending FOREVER: suspend() never re-runs
        // on an already-suspended conversation, and the controller (which respects the phase)
        // then keeps it in the demand count. Publishing Suspended here makes phase self-heal on
        // the next hydrate — the single place a pod re-observes a suspended conversation. A
        // RUNNING hydrate needs no publish: revive()/the assign path sets Assigned. Owner-fenced.
        if (entry.status === "suspended" && ownershipGuard.canWrite(entry.id)) {
          void conversationRegistry.setPhase(entry.id, "Suspended");
        }
      }

      // ADOPT the conversations the CR says are ours but the local cache never had. This is the
      // path that was missing entirely: previously the loop above was the ONLY one, keyed by local
      // metas, so a wiped emptyDir meant nothing was hydrated however much the cluster knew.
      for (const c of mine) {
        if (entries.has(c.id)) continue; // already live or hydrated from the local cache
        // A conversation with no meta is still adopted from the CR alone — enough to be
        // listed, suspended and reclaimed, which is what closes the sandbox leak.
        const meta = metaById.get(c.id);
        const synthesized: ConversationMeta = meta ?? {
          id: c.id,
          threadId: c.id,
          title: "",
          createdAt: nowMs(),
          lastActivityAt: nowMs(),
          // NB: no `status` here — that lives on Entry, not the persisted meta. hydrateEntry()
          // derives it from whether reconcile() reports the Sandbox pod actually running.
          model: c.spec.model,
          owner: c.spec.owner,
          parentId: c.spec.parentId,
        };
        // The CR's spec is authoritative for these — a local meta can be stale (e.g. the owner was
        // set after this pod last wrote its cache).
        if (c.spec.owner) synthesized.owner = c.spec.owner;
        if (c.spec.model) synthesized.model = c.spec.model;
        // Is the Sandbox actually up? `reconcile()` already told us; key by the CR's sandboxRef
        // when it has one (authoritative) and fall back to the derived name.
        const sandboxName = c.spec.sandboxRef ?? `conv-${shortId(synthesized.threadId)}`;
        const entry = hydrateEntry(synthesized, live.get(sandboxName));
        entries.set(c.id, entry);
      }
    },

    async resumeInterrupted(opts) {
      const concurrency = Math.max(1, opts?.concurrency ?? 3);
      // Find hydrated conversations whose LAST run is dangling (started, never
      // finished) — the tail is enough to decide, so read only that.
      const candidates: SessionId[] = [];
      for (const entry of entries.values()) {
        if (entry.status === "ended") continue;
        try {
          // Read the log to check if its last run dangles. A one-time boot scan;
          // hasDanglingRun only needs the tail, but reading the whole log here is
          // fine (bounded per conversation, once).
          const events = await collectEvents(store.readEvents(entry.id));
            // NO `self` here, deliberately. This is the BOOT scan: this process has not
            // started any run yet, so every RUN_STARTED in the log predates it and is
            // stranded by definition — even one stamped with our own pod name (a restarted
            // pod reuses it). Passing self would skip the very runs this scan resumes.
          const info = danglingRunInfo(events);
          if (info?.cancelRequested) {
            // Stopped by the user before the previous process died — end it, don't redo it.
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
          } else if (info) {
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

      // Bounded concurrency: revive + nudge each. A cold start could have many, so
      // don't spawn every goose at once. prompt() revives if there's no bridge.
      const resumed: SessionId[] = [];
      const queue = [...candidates];
      const worker = async () => {
        for (;;) {
          const id = queue.shift();
          if (!id) return;
          try {
            // source "resume" → SYSTEM_MESSAGE (UI-hidden); see reviveFromMirror.
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
      // A conversation with any non-terminal DESCENDANT must not be swept: its
      // subagents share the same pod, which suspend() would drop out from under
      // them. Recursive (grandchildren keep the ancestor chain alive).
      const hasLiveDescendant = (id: SessionId): boolean => {
        for (const c of entries.values()) {
          if (c.parentId !== id) continue;
          if (c.status !== "ended") return true; // a live child
          if (hasLiveDescendant(c.id)) return true; // ...or a live grandchild
        }
        return false;
      };
      for (const entry of entries.values()) {
        if (entry.status !== "running") continue;
        // OWNERSHIP FILTER (the #297 residual, finally). Multi-replica, BOTH pods can hold
        // the same conversation (dual adoption); without this they both swept it ~3s apart.
        // The second sweeper's background-job EXEC PROBE rides the pollForReadyPod
        // self-heal, which RESUMES the sandbox the first sweeper just suspended — and with
        // the conversation then evicted everywhere, nothing ever re-suspends it. Observed
        // on valhalla: three sandbox pods running 9-12h, conversations phase=Suspended,
        // each with two 'idle-suspended' log lines 3.5s apart. Only the OWNER sweeps —
        // and, as importantly, only the owner PROBES.
        if (!ownershipGuard.canWrite(entry.id)) continue;
        if (now - entry.lastActivityAt < idleMs) continue;
        if (hasLiveDescendant(entry.id)) continue; // keep the shared pod up
        // NEVER suspend a conversation with a run IN FLIGHT. lastActivityAt is bumped
        // at prompt boundaries, not continuously during a turn — so a single agent
        // turn that runs longer than idleMs (a long nix build, a big test suite, a
        // slow/stuck tool call) looks "idle" here even though goose is actively
        // working. Suspending then drops the pod out from under the live run: goose
        // gets SIGTERM'd (code=null), the ACP stdio pipe tears down, and the bridge
        // surfaces AbortError / ERR_STREAM_PREMATURE_CLOSE — cutting the conversation
        // mid-task. The bridge already knows if a run is active/queued (queueState),
        // so consult it: a running or backlogged conversation is NOT idle.
        const qs = entry.bridge?.queueState();
        if (qs && (qs.running || qs.queued > 0)) continue;
        // NEVER suspend a conversation with a RUNNING background job (run_background). It's a
        // detached in-pod process; suspend drops the pod → the job is SIGTERM'd mid-run and its
        // work is lost, even though lastActivityAt (bumped only at prompt boundaries) makes the
        // conversation LOOK idle. Consult the job state, same as queueState covers active agent
        // work. Best-effort + FAIL-OPEN: a probe error must not pin the pod up forever, so a
        // throw is logged and the sweep proceeds (the pod can still be reclaimed).
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
          // Finding #18: retrying next sweep is right, but a conversation whose
          // suspend ALWAYS fails leaks a pod forever with zero signal. Log it so a
          // chronically-unsuspendable conversation is visible.
          // eslint-disable-next-line no-console
          log.errorWith("idle-suspend failed; will retry next sweep", err, { conversation_id: entry.id });
        }
      }
      return suspended;
    },

    async sweepRetention(maxAgeMs, now = nowMs()) {
      const reaped: SessionId[] = [];
      // Same shared-pod guard as sweepIdle: a conversation with any non-terminal
      // descendant owns a pod its subagents share — reaping it would destroy their
      // pod. (A subagent itself is reaped WITH its parent via end()'s cascade, so we
      // only consider top-level conversations here.)
      const hasLiveDescendant = (id: SessionId): boolean => {
        for (const c of entries.values()) {
          if (c.parentId !== id) continue;
          if (c.status !== "ended") return true;
          if (hasLiveDescendant(c.id)) return true;
        }
        return false;
      };
      // Snapshot first: end() mutates `entries` (deletes the subtree), so iterating it
      // live while ending would skip/reorder.
      const candidates = [...entries.values()].filter((entry) => {
        if (entry.parentId !== undefined) return false; // subagents die with their parent
        if (entry.starred) return false; // STARRED = exempt from auto-deletion
        if (now - entry.lastActivityAt < maxAgeMs) return false; // still recent
        if (hasLiveDescendant(entry.id)) return false; // keep the shared pod
        // Same in-flight guard as sweepIdle, but here it's defense-in-depth: end() is
        // DESTRUCTIVE (pod + PVCs), so never reap a conversation with a live/queued run
        // even if lastActivityAt looks stale. (Far less likely than the idle case — the
        // retention window is days, not minutes — but a wedged multi-day run would
        // otherwise be deleted mid-flight.)
        const qs = entry.bridge?.queueState();
        if (qs && (qs.running || qs.queued > 0)) return false;
        return true;
      });
      for (const entry of candidates) {
        try {
          await this.end(entry.id);
          reaped.push(entry.id);
        } catch (err) {
          // Best-effort: a failed reap retries next sweep. Log so a conversation that
          // can NEVER be reaped (e.g. a wedged provisioner.destroy) is visible.
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

/** Wall-clock ms. Wrapped so it's mockable / avoids new Date() in pure code. */
function nowMs(): number {
  return Date.now();
}
