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
import { hasDanglingRun } from "./danglingRun.js";
import { allowAllGuard, type OwnershipGuard } from "./ownershipGuard.js";
import { noopRegistry, type ConversationRegistry } from "./conversationRegistry.js";

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
  resume(ref: SandboxRef): Promise<SandboxRef>;
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
  /** The RECENT tail only: the events from the last `runs` runs, read WITHOUT
   *  parsing the whole log (scan from the end for RUN_STARTED boundaries) — so a
   *  fast first-paint window on a long conversation stays cheap. Optional (an
   *  in-memory store can fall back to reading all of readEvents). */
  readEventsTail?(id: SessionId, runs: number): Promise<AguiEvent[]>;
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
  /** Persist last-activity (ms epoch) so it survives restarts and is queryable
   *  by an external lifecycle manager. Optional. */
  recordActivity?(id: SessionId, at: number): Promise<void>;
  /** Persist conversation metadata (title/createdAt) so the list survives an
   *  agent-host restart. Optional (in-memory stores skip it). */
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
  /** Persist the agent-authored module.nix — the DURABLE source of truth for the
   *  conversation's self-modified environment (survives suspend/resume + restart).
   *  The agent-host syncs it into the per-conversation ConfigMap on modify + on
   *  revive, so the in-pod boot re-converge restores it. Optional. */
  saveModule?(id: SessionId, module: string): Promise<void>;
  /** Read the saved module.nix, or null if the conversation never modified its
   *  environment (revive skips the CM sync / re-apply for a pristine wake). */
  readModule?(id: SessionId): Promise<string | null>;
  /** Append a background-job record (run_background). The durable registry so
   *  list_background survives an agent-host restart. Optional. */
  saveJob?(id: SessionId, job: JobRecord): Promise<void>;
  /** The conversation's background-job records (newest first; [] if none). */
  listJobs?(id: SessionId): Promise<JobRecord[]>;
  /** Update a job record in place (by jobId), e.g. to mark notifiedAt. Optional. */
  updateJob?(id: SessionId, job: JobRecord): Promise<void>;
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
   *  pod, hydrating its history from the shared mirror first (this pod is its NEW owner after
   *  a rollout reassignment). Idempotent (no-op if already in memory). `expectedGen` is the
   *  CR's current generation for fencing — revive only if this pod is the current owner at
   *  that generation; a stale push (older gen) is a no-op. Distinct from `revive()`, which
   *  404s when the conversation isn't already local. DESIGN STUB — see
   *  todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md. */
  reviveFromMirror(id: SessionId, expectedGen: number): Promise<void>;
  /** READ-ONLY hydrate for a reconnecting UI: make a conversation's history available on
   *  THIS pod so the read routes (events / events.integrity) can serve it, WITHOUT starting
   *  the sandbox/bridge (unlike revive*). Pulls events from the mirror into local if absent,
   *  then registers the entry as a suspended placeholder. Returns true if the conversation
   *  exists anywhere (in memory, local, or mirror) — false ⇒ genuinely unknown (404). Cheap
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

  /**
   * Subscribe to conversation LIFECYCLE changes (a new conversation via start(),
   * or a title change via setTitle()) so the GET /conversations/events stream can
   * push the sidebar without the 10s poll. Fires with the changed Conversation
   * (the caller enriches with `sources`/view). Returns an unsubscribe fn.
   *
   * Design stage: SIGNATURE ONLY.
   */
  onConversationChange(cb: (conv: Conversation) => void): () => void;
}

/** Builds the ACP<->AG-UI bridge for a conversation (spawns goose in prod). */
export type BridgeFactory = (args: {
  conversationId: SessionId;
  sandbox: SandboxRef;
  /** Per-conversation model override (undefined = host default). */
  model?: string;
}) => SessionBridge | undefined;

export interface SessionManagerDeps {
  provisioner: SandboxProvisioner;
  store: ConversationStore;
  /** Optional multi-replica FENCING guard: before this pod appends to a conversation's
   *  log, canWrite() checks it still owns the conversation (Conversation CR hostPod/
   *  generation). Omitted / allowAllGuard = single-replica (always allow, today's
   *  behavior). See ownershipGuard.ts. */
  ownershipGuard?: OwnershipGuard;
  /** Optional (multi-replica revive-on-assign): pull ONE conversation's durable state from
   *  the shared mirror into local so this pod can hydrate + revive a conversation the
   *  controller just reassigned here (that this pod never owned). Returns false if the
   *  mirror has no such conversation. Wired to mirroredStore.hydrateFromMirror when a mirror
   *  is configured; omitted single-replica. Used by reviveFromMirror(). */
  hydrateFromMirror?: (id: SessionId) => Promise<boolean>;
  /** Optional multi-replica registry: on start()/spawnChild() this writes a Conversation
   *  CR so the controller can assign the conversation a hostPod and the router forwards to
   *  it. Omitted / noopRegistry = single-replica (no CR). See conversationRegistry.ts. */
  conversationRegistry?: ConversationRegistry;
  /** Optional: how to build a bridge per conversation. Omitted in unit tests
   *  that only assert lifecycle/provisioning. */
  bridgeFactory?: BridgeFactory;
  /** Optional: called after a conversation's bridge is (re)built by revive() — with
   *  a live bridge. index.ts uses it to re-raise approval interrupts a pod rollout
   *  dropped: the interrupt's in-memory answer-routing is lost on restart, but the
   *  request still sits PENDING in the broker (source of truth), so on revive we
   *  re-query + re-raise. Fire-and-forget; a failure must not fail the revive. */
  onRevived?: (id: SessionId) => void;
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
        console.error(`[manager] onSubagentComplete listener threw for ${subagentId}:`, err);
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

  // Conversation lifecycle subscribers (the /conversations/events push stream).
  // Fired by start() (new conversation) and setTitle() (title change) so the
  // sidebar updates without waiting on the 10s poll. Fire-and-forget + cheap:
  // it passes the Conversation only; the stream handler enriches with `sources`.
  const changeSubs = new Set<(c: Conversation) => void>();
  const emitChange = (e: Entry): void => {
    const c = toConversation(e);
    for (const cb of changeSubs) cb(c);
  };

  const touch = (e: Entry) => {
    e.lastActivityAt = nowMs();
    void store.recordActivity?.(e.id, e.lastActivityAt);
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
      console.error(`[manager] hydrateByThread(${threadId}) store lookup FAILED (may create a duplicate):`, err);
      return undefined;
    }
    const m = metas.find((x) => x.threadId === threadId);
    if (!m) return undefined;
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
    return hydrateEntry(m, onCluster);
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
    }) ?? Promise.resolve();

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
      if (!ownershipGuard.canWrite(e.id)) return;
      void store.appendEvent(e.id, event);
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

  return {
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
      emitChange(entry); // push the new conversation to the sidebar stream (live)

      // Register the assignment-table CR so the controller assigns a hostPod and the
      // router forwards subsequent requests here. Idempotent + non-throwing (a k8s
      // failure must not fail the conversation); noop in single-replica mode. Do it
      // BEFORE the slow provision so assignment can happen while the sandbox spins up.
      await conversationRegistry.register(id, { model, owner, sandboxRef: entry.sandbox.name });

      // Now provision the sandbox (seconds) and attach the bridge. Short hash → k8s
      // resource names; full threadId → the shareable CONVERSATION_URL (?thread=<id>).
      entry.sandbox = await provisioner.create(shortId(threadId), threadId);
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model });
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
      emitChange(entry); // show it in the sidebar live (nested under the parent)

      // Register the child CR carrying parentId so the controller CO-LOCATES it on the
      // parent's pod (it shares the parent's sandbox). Idempotent + non-throwing; noop in
      // single-replica mode.
      await conversationRegistry.register(id, {
        model, owner: parent.owner, parentId, sandboxRef: entry.sandbox.name,
      });

      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model });
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
        ? await provisioner.resume(entry.sandbox)
        : await provisioner.create(shortId(entry.threadId), entry.threadId);
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model: entry.model }) ?? entry.bridge;
      entry.status = "running";
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
          console.error(`[manager] onRevived hook failed for ${id}:`, err);
        }
      }
      return toConversation(entry);
    },

    async reviveFromMirror(id, expectedGen) {
      // REVIVE-ON-ASSIGN (seamless rollout): the controller pushes this on a conversation's
      // NEW host right after (re)assigning it. See todo/docs/ROLLOUT_DRAIN_AND_POD_IP.md.

      // FENCE: only revive if this pod is the current owner at `expectedGen`. canWrite()
      // fails OPEN when unobserved (the CR watch may lag the push), which is safe — a
      // genuinely stale push still can't advance the log (append is fenced too), and
      // reviving a conversation we don't own is a harmless read+resume that the next
      // reconcile corrects. But a POSITIVE "another pod owns it" verdict → skip.
      if (!ownershipGuard.canWrite(id)) {
        return; // fenced out — not our conversation (a stale push).
      }

      // Already live here → idempotent no-op.
      if (entries.get(id)) return;

      // Not in memory: pull its durable state from the mirror into local, then hydrate the
      // Entry (hydrateByThread reads the now-local meta) and revive it. threadId === id.
      if (deps.hydrateFromMirror) {
        const pulled = await deps.hydrateFromMirror(id).catch((err) => {
          console.error(`[manager] reviveFromMirror(${id}) mirror pull failed:`, err);
          return false;
        });
        if (!pulled) return; // mirror has nothing — genuinely unknown; nothing to revive.
      }
      const entry = await hydrateByThread(id as ThreadId);
      if (!entry) return; // still not reconstructable (no local meta) — give up quietly.
      void expectedGen; // gen already enforced via the fence above + the append guard.
      await this.revive(id);
    },

    async ensureReadable(id) {
      // Already known to this pod → readable.
      if (entries.get(id)) return true;
      // Pull its durable state (meta + events) from the mirror into local if a mirror is
      // configured — so a reconnecting UI (GET events / events.integrity) can read history
      // even after the owner pod moved (rollout) or the CR was cleared. READ-ONLY: no
      // sandbox/bridge spin-up (unlike revive*). hydrateByThread then registers the entry as
      // a suspended placeholder; the next prompt revives the pod on demand.
      if (deps.hydrateFromMirror) {
        await deps.hydrateFromMirror(id).catch((err) => {
          console.error(`[manager] ensureReadable(${id}) mirror pull failed:`, err);
          return false;
        });
      }
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
        // A genuinely new webhook thread: stamp the resolved owner (if any) so the
        // conversation belongs to the invoking external user's Scooter account.
        const conv = await this.start(threadId, model, owner);
        entry = entries.get(conv.id)!;
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
      await this.prompt(id, MODEL_SWITCH_NUDGE);
      return true;
    },

    async suspend(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      await entry.bridge?.stop();
      await provisioner.suspend(entry.sandbox);
      entry.bridge = undefined;
      entry.status = "suspended";
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
        console.error(`[manager] getByShortId(${shortHash}) store lookup FAILED:`, err);
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
      const persisted = saveMeta(entry); // persist the agent-assigned title
      emitChange(entry); // push the title change to the sidebar stream
      return persisted;
    },

    setUserTitle(id, title) {
      const entry = entries.get(id);
      if (!entry) return Promise.resolve();
      entry.title = title;
      entry.userTitled = true; // lock it: the agent's <title> no longer wins
      const persisted = saveMeta(entry);
      emitChange(entry);
      return persisted;
    },

    setStarred(id, starred) {
      const entry = entries.get(id);
      if (!entry) return Promise.resolve();
      entry.starred = starred;
      const persisted = saveMeta(entry);
      emitChange(entry);
      return persisted;
    },

    async hydrate() {
      const metas = (await store.listConversations?.()) ?? [];

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
            console.error(`[manager] hydrate reconcile FAILED after ${RETRIES} attempts — assuming all suspended (pod-leak risk if persistent):`, err);
          } else {
            // Exponential backoff (250ms, 500, 1s, 2s) to ride out a boot blip.
            const delay = 250 * 2 ** attempt;
            // eslint-disable-next-line no-console
            console.warn(`[manager] hydrate reconcile attempt ${attempt + 1}/${RETRIES} failed (retrying in ${delay}ms):`, (err as Error)?.message ?? err);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
      void reconciled; // (kept for readability; the fallback path already logged)

      for (const m of metas) {
        if (entries.has(m.id)) continue; // a live one already exists
        const name = `conv-${shortId(m.threadId)}`;
        hydrateEntry(m, live.get(name));
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
          if (hasDanglingRun(events)) candidates.push(entry.id);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[manager] resumeInterrupted: reading ${entry.id}'s log failed (skipping):`, err);
        }
      }
      if (candidates.length === 0) return [];
      // eslint-disable-next-line no-console
      console.log(`[manager] resuming ${candidates.length} interrupted conversation(s) after restart`);

      // Bounded concurrency: revive + nudge each. A cold start could have many, so
      // don't spawn every goose at once. prompt() revives if there's no bridge.
      const resumed: SessionId[] = [];
      const queue = [...candidates];
      const worker = async () => {
        for (;;) {
          const id = queue.shift();
          if (!id) return;
          try {
            await this.prompt(id, RESUME_NUDGE);
            resumed.push(id);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`[manager] resumeInterrupted: resuming ${id} failed:`, err);
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
        try {
          await this.suspend(entry.id);
          suspended.push(entry.id);
        } catch (err) {
          // Finding #18: retrying next sweep is right, but a conversation whose
          // suspend ALWAYS fails leaks a pod forever with zero signal. Log it so a
          // chronically-unsuspendable conversation is visible.
          // eslint-disable-next-line no-console
          console.error(`[manager] idle-suspend failed for ${entry.id} (will retry next sweep):`, err);
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
          console.error(`[manager] retention reap failed for ${entry.id} (will retry next sweep):`, err);
        }
      }
      return reaped;
    },

    onConversationChange(cb) {
      changeSubs.add(cb);
      return () => changeSubs.delete(cb);
    },

    onSubagentComplete(cb) {
      subagentCompleteSubs.add(cb);
      return () => subagentCompleteSubs.delete(cb);
    },
  };
}

/** Wall-clock ms. Wrapped so it's mockable / avoids new Date() in pure code. */
function nowMs(): number {
  return Date.now();
}
