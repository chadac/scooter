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
import type { SessionBridge, AguiEvent, InterruptPolicy } from "../bridge.js";
import { hasDanglingRun } from "./danglingRun.js";

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
  /** Persist the agent's self-authored module into the per-conversation module
   *  ConfigMap (upsert: creates it if missing). The PVC is the source of truth;
   *  this is the in-pod delivery copy the boot re-converge reads. Called after a
   *  clean live apply AND on revive() (synced from the PVC). Optional (the
   *  noop/local provisioner has no ConfigMap). */
  writeModule?(conversationId: string, module: string): Promise<void>;
  /** Ensure the Sandbox's podTemplate MOUNTS the per-conversation module
   *  ConfigMap at the boot re-converge path. A one-time self-heal for Sandboxes
   *  created before module-CM provisioning existed (their podTemplate lacks the
   *  volume/mount, so a CM sync would never reach the pod). Must run BEFORE the
   *  pod boots (i.e. before resume flips replicas). No-op / returns false when the
   *  mount is already present. Optional. */
  ensureModuleMount?(conversationId: string): Promise<void>;
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
}

export interface SessionManager {
  /** Start a brand-new conversation (cold Sandbox + goose + PVCs). `model`
   *  selects the agent model (validated by the caller); `owner` is the creating
   *  user (the ingress identity) recorded for the view filter. */
  start(threadId: ThreadId, model?: string, owner?: string): Promise<Conversation>;
  /** Re-attach to / revive a suspended conversation (resume + replay log). */
  revive(id: SessionId): Promise<Conversation>;
  /** Forward a user prompt into the conversation's goose session. An optional
   *  `model` switches the conversation's model: if it differs from the current
   *  one, the live goose session is rebuilt with the new model. `priority`
   *  (PRIORITY_INTERRUPT) lets an @mention force-interrupt a running turn after the
   *  bridge's priority timeout; normal prompts (default) wait their turn. */
  prompt(id: SessionId, text: string, model?: string, priority?: number, interrupt?: InterruptPolicy): Promise<void>;
  /** Find-or-start the conversation for an AG-UI thread, then prompt it. A
   *  `model` on the FIRST prompt picks the conversation's model; on a later
   *  prompt it switches it (rebuilds the goose session). `priority` as in prompt(). */
  promptByThread(threadId: ThreadId, text: string, model?: string, priority?: number): Promise<void>;
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
  /** All conversations, newest first. */
  list(): Conversation[];
  /** Set a conversation's title (e.g. agent-assigned). */
  /** Set a conversation's title and persist it. Returns the persist promise so a
   *  caller can await durability (e.g. before a restart); fire-and-forget callers
   *  may ignore it. */
  setTitle(id: SessionId, title: string): Promise<void>;
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
}

/** Drain an async iterable of events into an array (fallback for stores without
 *  readEventsTail — in-memory test stores, whose logs are tiny). */
async function collectEvents(it: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** Short, DNS-1123-safe id derived from a (possibly UUID) thread id. */
function shortId(threadId: string): string {
  let h = 0;
  for (let i = 0; i < threadId.length; i++) h = (h * 31 + threadId.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { provisioner, store, bridgeFactory } = deps;
  const entries = new Map<SessionId, Entry>();

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

    async revive(id) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);

      // Restore the conversation's self-modified environment from the DURABLE PVC
      // source of truth. The PVC survives suspend/resume + agent-host restart; the
      // per-conversation ConfigMap is the in-pod delivery copy the boot re-converge
      // reads. This MUST happen BEFORE the pod boots (before resume flips replicas /
      // create makes the pod), so the booting pod mounts the fresh CM and the boot
      // re-converge applies it — hence the sync is ordered ahead of resume/create.
      // A pristine conversation (no saved module, or empty) skips this entirely and
      // wakes on the base config with no rebuild cost.
      const rid = shortId(entry.threadId); // the k8s-name id writeModule/ensureModuleMount key on
      const savedModule = (await store.readModule?.(id)) ?? null;
      if (savedModule && savedModule.trim() !== "") {
        // Old Sandboxes (created before module-CM provisioning) don't mount the CM;
        // repair the podTemplate so the sync actually reaches the pod on this boot.
        await provisioner.ensureModuleMount?.(rid);
        await provisioner.writeModule?.(rid, savedModule); // upsert the CM from the PVC
      }

      // A HYDRATED conversation (restored from disk after a restart) has a
      // placeholder sandbox ref with no namespace — its pod was never created in
      // THIS process (and a suspended Sandbox may have been GC'd). Re-create the
      // sandbox rather than resume a ref this process never owned.
      entry.sandbox = entry.sandbox.namespace
        ? await provisioner.resume(entry.sandbox)
        : await provisioner.create(shortId(entry.threadId), entry.threadId);
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model: entry.model }) ?? entry.bridge;
      entry.status = "running";
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

    async prompt(id, text, model, priority, interrupt) {
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
      await entry.bridge?.prompt({ threadId: entry.threadId, text }, opts);
    },

    async promptByThread(threadId, text, model, priority) {
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
        const conv = await this.start(threadId, model);
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
        { threadId, text },
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
      await entry.bridge?.stop();
      await provisioner.destroy(entry.sandbox);
      entry.bridge = undefined;
      entry.status = "ended";
      // Delete-don't-tombstone: drop it from the in-memory list AND remove its
      // persisted state, so it neither shows in GET /conversations nor returns
      // on the next hydrate(). (Suspend, not end, is the durable handle.)
      entries.delete(id);
      await store.removeConversation?.(id);
    },

    get(id) {
      const entry = entries.get(id);
      return entry ? toConversation(entry) : undefined;
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
      entry.title = title;
      const persisted = saveMeta(entry); // persist the (possibly agent-assigned) title
      emitChange(entry); // push the title change to the sidebar stream
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
      for (const entry of entries.values()) {
        if (entry.status !== "running") continue;
        if (now - entry.lastActivityAt < idleMs) continue;
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

    onConversationChange(cb) {
      changeSubs.add(cb);
      return () => changeSubs.delete(cb);
    },
  };
}

/** Wall-clock ms. Wrapped so it's mockable / avoids new Date() in pure code. */
function nowMs(): number {
  return Date.now();
}
