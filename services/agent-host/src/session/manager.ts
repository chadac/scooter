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
import type { SessionBridge, AguiEvent } from "../bridge.js";

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
  /** Cold-create a Sandbox: SA sandbox-{id}, workspace + conversation PVCs. */
  create(conversationId: string): Promise<SandboxRef>;
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
   *  ConfigMap (durable across suspend/resume). Called after a clean live apply.
   *  Optional (the noop/local provisioner has no ConfigMap). */
  writeModule?(conversationId: string, module: string): Promise<void>;
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
   *  one, the live goose session is rebuilt with the new model. */
  prompt(id: SessionId, text: string, model?: string): Promise<void>;
  /** Find-or-start the conversation for an AG-UI thread, then prompt it. A
   *  `model` on the FIRST prompt picks the conversation's model; on a later
   *  prompt it switches it (rebuilds the goose session). */
  promptByThread(threadId: ThreadId, text: string, model?: string): Promise<void>;
  suspend(id: SessionId): Promise<void>;
  end(id: SessionId): Promise<void>;

  get(id: SessionId): Conversation | undefined;
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
   *  revive), and persists the change so a restart keeps it. */
  const applyModelSwitch = async (e: Entry, model?: string): Promise<void> => {
    if (model === undefined || model === e.model) return;
    e.model = model;
    if (e.bridge) {
      await e.bridge.stop();
      e.bridge = undefined; // prompt()/promptByThread revive -> rebuild with e.model
    }
    await saveMeta(e);
  };

  return {
    async start(threadId, model, owner) {
      // The conversation id IS the thread id, so AG-UI events broadcast/persist
      // under the same key the UI subscribes by. The sandbox (k8s) name uses a
      // short DNS-safe hash of it.
      const id: SessionId = threadId;
      const sandbox = await provisioner.create(shortId(threadId));
      const bridge = bridgeFactory?.({ conversationId: id, sandbox, model });
      const entry: Entry = {
        id, threadId, sandbox, bridge, status: "running",
        title: "New chat", createdAt: nowMs(), lastActivityAt: nowMs(), model, owner,
      };
      entries.set(id, entry);
      wireEventLog(entry);
      // Await the persist so a started conversation is durable before we return
      // (a crash right after start() must not lose it; and hydrate() in another
      // process must see it). setTitle stays fire-and-forget.
      await saveMeta(entry);
      emitChange(entry); // push the new conversation to the sidebar stream
      // NOTE: do NOT eagerly bridge.start() here — that spawns goose and blocks
      // on its ACP newSession. bridge.prompt() lazily starts on first use, after
      // emitting RUN_STARTED, so the UI always sees the run begin.
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
        : await provisioner.create(shortId(entry.threadId));
      entry.bridge = bridgeFactory?.({ conversationId: id, sandbox: entry.sandbox, model: entry.model }) ?? entry.bridge;
      entry.status = "running";
      wireEventLog(entry);
      saveMeta(entry);
      await entry.bridge?.start();
      // Event-log replay to a reattaching UI is driven by the AG-UI server's
      // onAttach handler reading store.readEvents(id); nothing to do here.
      return toConversation(entry);
    },

    async prompt(id, text, model) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`unknown conversation: ${id}`);
      touch(entry);
      await applyModelSwitch(entry, model);
      // Revive whenever there's no LIVE bridge (goose process), not just when the
      // status is non-running: a HYDRATED conversation can be status "running"
      // (its pod is up, per hydrate's reconcile) yet have no bridge in THIS
      // process, so the prompt would silently no-op (bridge?.prompt on undefined).
      if (!entry.bridge) await this.revive(id);
      await entry.bridge?.prompt({ threadId: entry.threadId, text });
    },

    async promptByThread(threadId, text, model) {
      // Find the conversation for this thread, or start one on first prompt
      // (the FIRST prompt's model picks the conversation's model).
      let entry = [...entries.values()].find((e) => e.threadId === threadId);
      if (!entry) {
        const conv = await this.start(threadId, model);
        entry = entries.get(conv.id)!;
      } else {
        await applyModelSwitch(entry, model);
        if (!entry.bridge) {
          // No live bridge -> revive (start goose). Covers both suspended AND
          // hydrated-but-"running" conversations (pod up, no goose in this process).
          await this.revive(entry.id);
        }
      }
      touch(entry);
      await entry.bridge?.prompt({ threadId, text });
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
      const live = new Map<string, { ref: SandboxRef; running: boolean }>();
      try {
        for (const s of (await provisioner.reconcile?.()) ?? []) {
          live.set(s.ref.name, s);
        }
      } catch (err) {
        // Finding #10: the fallback (assume-suspended) is correct, but swallowing
        // SILENTLY hides a persistently-failing reconcile — and a reconcile that
        // never succeeds means still-running pods are all marked 'suspended' and
        // the idle sweep (running-only) never reclaims them: the exact pod leak
        // this reconcile exists to prevent. Log loudly so it's observable.
        // eslint-disable-next-line no-console
        console.error("[manager] hydrate reconcile FAILED — assuming all suspended (pod-leak risk if persistent):", err);
      }

      for (const m of metas) {
        if (entries.has(m.id)) continue; // a live one already exists
        const name = `conv-${shortId(m.threadId)}`;
        const onCluster = live.get(name);
        // If the Sandbox's pod is still running, track it as RUNNING with its real
        // namespace so suspend()/sweepIdle() can act on it. Otherwise it's a
        // resumable (suspended) conversation — revive() recreates it on use; the
        // empty-namespace placeholder signals "create a fresh pod".
        entries.set(m.id, {
          id: m.id,
          threadId: m.threadId,
          sandbox: onCluster?.running ? onCluster.ref : { name, namespace: "" },
          bridge: undefined,
          status: onCluster?.running ? "running" : "suspended",
          title: m.title,
          createdAt: m.createdAt,
          lastActivityAt: m.lastActivityAt,
          model: m.model,
          owner: m.owner,
        });
      }
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
