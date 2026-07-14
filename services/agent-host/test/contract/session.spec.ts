/**
 * Tier 1 contract test — SessionManager lifecycle with fake provisioner + store.
 *
 * Proves: start (cold sandbox), prompt, suspend (keep handle), revive (replay
 * event log), end. RED against Design interfaces.
 */

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSessionManager,
  type SandboxProvisioner,
  type ConversationStore,
} from "../../src/session/manager.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";

const fakeProvisioner = (): SandboxProvisioner => {
  const refs = new Map<string, SandboxRef>();
  return {
    create: vi.fn(async (id) => {
      const ref = { name: `conv-${id}`, namespace: "ns" };
      refs.set(id, ref);
      return ref;
    }),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async (ref) => ref),
    destroy: vi.fn(async () => {}),
  };
};

const inMemoryStore = (): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
  };
};

describe("SessionManager", () => {
  it("start() provisions a cold sandbox and a running conversation", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });

    const conv = await sessions.start("thread-1");

    expect(provisioner.create).toHaveBeenCalledOnce();
    // create(shortDnsSafeId, FULL threadId): the 1st arg names k8s resources (a
    // short hash), the 2nd is the full conversation id the shareable
    // CONVERSATION_URL (?thread=<id>) must use — else the agent's link resolves to
    // the wrong conversation and permission prompts land in the wrong place.
    const [nameId, urlThread] = (provisioner.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(urlThread).toBe("thread-1");
    expect(nameId).not.toBe("thread-1"); // the NAME id is the short hash, not the full id
    expect(conv.status).toBe("running");
    expect(conv.sandbox.name).toMatch(/^conv-/);
  });

  it("registers the conversation BEFORE the (slow) sandbox provisioning finishes", async () => {
    // The 'new chat' 404 race: the UI POSTs /agui then IMMEDIATELY opens
    // events.integrity, which sessions.get(id)s. If start() only registers the
    // conversation AFTER awaiting provisioning (seconds), that fetch 404s and the
    // UI gives up → a new chat looks broken. So the conversation must be
    // get()-able from the moment start() begins provisioning.
    let releaseCreate!: () => void;
    const gate = new Promise<void>((r) => { releaseCreate = r; });
    const provisioner: SandboxProvisioner = {
      create: vi.fn(async (id) => { await gate; return { name: `conv-${id}`, namespace: "ns" }; }),
      suspend: vi.fn(async () => {}),
      resume: vi.fn(async (ref) => ref),
      destroy: vi.fn(async () => {}),
    };
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });

    const startP = sessions.start("thread-race"); // provisioning is gated (in flight)
    await Promise.resolve(); // let start() run up to the awaited create()
    // The UI would hit events.integrity now — the conversation MUST already exist.
    expect(sessions.get("thread-race"), "conversation must be registered before provisioning completes").toBeTruthy();
    expect(sessions.get("thread-race")?.status).toBe("running");

    releaseCreate(); // provisioning completes
    await startP;
    expect(sessions.get("thread-race")?.sandbox.namespace).toBe("ns"); // real ref attached
  });

  it("suspend() keeps the conversation handle (suspend-don't-delete)", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const conv = await sessions.start("thread-1");

    await sessions.suspend(conv.id);

    expect(provisioner.suspend).toHaveBeenCalledOnce();
    expect(provisioner.destroy).not.toHaveBeenCalled();
    expect(sessions.get(conv.id)?.status).toBe("suspended");
  });

  it("revive() resumes the same sandbox and replays the event log", async () => {
    const provisioner = fakeProvisioner();
    const store = inMemoryStore();
    const sessions = createSessionManager({ provisioner, store });
    const conv = await sessions.start("thread-1");
    await store.appendEvent(conv.id, { type: "RUN_STARTED", threadId: "thread-1", runId: "r1" });
    await sessions.suspend(conv.id);

    const revived = await sessions.revive(conv.id);

    expect(provisioner.resume).toHaveBeenCalledOnce();
    expect(revived.sandbox.name).toBe(conv.sandbox.name); // same body
    expect(revived.status).toBe("running");
  });

  it("revive() calls onRevived (with a live bridge) so index.ts can re-raise dropped interrupts", async () => {
    // A pod rollout loses in-memory approval interrupts; index.ts wires onRevived to
    // re-query the broker for PENDING requests and re-raise them. Assert the hook
    // fires on revive with the conversation id, AFTER the bridge is live.
    const revived: string[] = [];
    const bridgeFactory = () =>
      ({
        start: vi.fn(async () => {}),
        prompt: vi.fn(async () => "run-x"),
        stop: vi.fn(async () => {}),
        onEvent: () => () => {},
        onPersist: () => () => {},
        onTitle: () => () => {},
      }) as never;
    const store = inMemoryStore();
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store,
      bridgeFactory,
      onRevived: (id) => revived.push(id),
    });
    const conv = await sessions.start("thread-1");
    await sessions.suspend(conv.id);
    revived.length = 0; // ignore anything before the revive under test

    await sessions.revive(conv.id);
    expect(revived).toEqual([conv.id]);
  });

  it("prompt() threads priority + interrupt policy through to the bridge (job-completion watcher path)", async () => {
    const optsSeen: Array<{ priority?: number; interrupt?: string } | undefined> = [];
    const bridgeFactory = () =>
      ({
        start: vi.fn(async () => {}),
        prompt: vi.fn(async (_input: unknown, opts?: { priority?: number; interrupt?: string }) => {
          optsSeen.push(opts);
          return "run-x";
        }),
        stop: vi.fn(async () => {}),
        onEvent: () => () => {},
        onPersist: () => () => {},
        onTitle: () => () => {},
      }) as never;
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory });
    const conv = await sessions.start("thread-1");

    // The watcher injects with PRIORITY_INTERRUPT + "thinking" so it preempts idle
    // thinking but never kills an in-flight tool call.
    await sessions.prompt(conv.id, "[System] job x finished", undefined, 10, "thinking");

    expect(optsSeen.at(-1)).toEqual({ priority: 10, interrupt: "thinking" });
  });

  it("promptByThread() sends a PRIORITY @mention with the \"thinking\" policy (preempt thinking, spare a running tool call)", async () => {
    const optsSeen: Array<{ priority?: number; interrupt?: string } | undefined> = [];
    const bridgeFactory = () =>
      ({
        start: vi.fn(async () => {}),
        prompt: vi.fn(async (_input: unknown, opts?: { priority?: number; interrupt?: string }) => {
          optsSeen.push(opts);
          return "run-x";
        }),
        stop: vi.fn(async () => {}),
        onEvent: () => () => {},
        onPersist: () => () => {},
        onTitle: () => () => {},
      }) as never;
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory });
    await sessions.start("thread-1");

    // A priority @mention (webhook -> priority=10) must interrupt the agent's
    // THINKING but NOT a running tool call — so it rides the "thinking" policy, not
    // the bridge default "timeout" (which hard-cancels the tool call).
    await sessions.promptByThread("thread-1", "<@BOT> take a look", undefined, 10);
    expect(optsSeen.at(-1)).toEqual({ priority: 10, interrupt: "thinking" });

    // A NORMAL (non-priority) prompt waits its turn — no priority/interrupt opts.
    await sessions.promptByThread("thread-1", "just a heads up", undefined, undefined);
    expect(optsSeen.at(-1)).toBeUndefined();
  });

  it("promptByThread() stamps the owner on a NEW thread, but not on an existing one", async () => {
    const bridgeFactory = () =>
      ({
        start: vi.fn(async () => {}),
        prompt: vi.fn(async () => "run-x"),
        stop: vi.fn(async () => {}),
        onEvent: () => () => {},
        onPersist: () => () => {},
        onTitle: () => () => {},
      }) as never;
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory });

    // A brand-new webhook thread with a resolved owner -> the conversation is owned.
    await sessions.promptByThread("wh-thread", "hi from slack", undefined, undefined, "user-alice");
    const created = [...sessions.list()].find((c) => c.threadId === "wh-thread");
    expect(created?.owner).toBe("user-alice");

    // A follow-up to the SAME (now-existing) thread with a different owner does NOT
    // change ownership — owner is stamped only at start.
    await sessions.promptByThread("wh-thread", "follow up", undefined, undefined, "user-bob");
    expect(sessions.get(created!.id)?.owner).toBe("user-alice");
  });

  it("end() destroys the sandbox and GCs the conversation", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const conv = await sessions.start("thread-1");

    await sessions.end(conv.id);

    expect(provisioner.destroy).toHaveBeenCalledOnce();
    // Delete-don't-tombstone: an ended conversation is GC'd from the list (and
    // its persisted state removed), so it no longer resolves.
    expect(sessions.get(conv.id)).toBeUndefined();
    expect(sessions.list()).toHaveLength(0);
  });

  it("the file store dedups + persists external resource links", async () => {
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      await store1.addLink!("c1", { source: "github", resourceType: "pull_request", url: "https://gh/pr/1", title: "PR #1" });
      // Same link again -> deduped.
      await store1.addLink!("c1", { source: "github", resourceType: "pull_request", url: "https://gh/pr/1", title: "PR #1" });
      await store1.addLink!("c1", { source: "slack", resourceType: "thread", title: "#eng thread" });
      expect(await store1.listLinks!("c1")).toHaveLength(2);

      // A fresh store over the same dir sees the persisted links (survive restart).
      const store2 = createFileConversationStore(root);
      const links = await store2.listLinks!("c1");
      expect(links.map((l) => l.source).sort()).toEqual(["github", "slack"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("conversations survive a restart (file store hydrate)", async () => {
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      // First "process": create two conversations + give one a title.
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      await m1.start("alpha");
      await m1.start("beta");
      await m1.setTitle("alpha", "Refactor the parser"); // await durability before the "restart"
      expect(m1.list()).toHaveLength(2);

      // Second "process": a fresh manager over the SAME store. hydrate() must
      // repopulate the list from disk (the in-memory entries are gone).
      const store2 = createFileConversationStore(root);
      const m2 = createSessionManager({ provisioner: fakeProvisioner(), store: store2 });
      expect(m2.list()).toHaveLength(0); // nothing in memory yet
      await m2.hydrate();

      const restored = m2.list();
      expect(restored).toHaveLength(2);
      const alpha = restored.find((c) => c.id === "alpha");
      expect(alpha?.title).toBe("Refactor the parser"); // persisted title
      expect(alpha?.status).toBe("suspended"); // resumable, not live
      expect(restored.find((c) => c.id === "beta")).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrate reconciles a still-running Sandbox as running so the idle sweep reclaims it", async () => {
    // The leak bug: after a restart the pods may NOT have been suspended, but
    // hydrate() assumed they were -> sweepIdle (running-only) never reclaimed
    // them. With reconcile(), a Sandbox whose pod is still up is tracked running.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("gamma");
      const sandboxName = m1.get(conv.id)!.sandbox.name; // conv-<shortId>

      // Fresh "process": its provisioner reports that conv's pod is STILL running.
      const prov2 = fakeProvisioner();
      prov2.reconcile = vi.fn(async () => [
        { ref: { name: sandboxName, namespace: "ns" }, running: true },
      ]);
      const m2 = createSessionManager({ provisioner: prov2, store: createFileConversationStore(root) });
      await m2.hydrate();

      // Reconciled as running (not assume-suspended), with the real namespace.
      expect(m2.get(conv.id)?.status).toBe("running");

      // ...so the idle sweep can now actually suspend it (the leak is reclaimed).
      const swept = await m2.sweepIdle(0); // 0 idle threshold -> everything idle
      expect(swept).toContain(conv.id);
      expect(prov2.suspend).toHaveBeenCalledOnce();
      expect(m2.get(conv.id)?.status).toBe("suspended");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrate RETRIES a transient reconcile failure (rides out a boot apiserver blip)", async () => {
    // The outage: a boot-time 429 ("storage is (re)initializing") failed the
    // reconcile ONCE, and hydrate served forever with an EMPTY map -> every prompt
    // took create -> 409. Retrying rides out the blip so the map is CORRECT.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("delta");
      const sandboxName = m1.get(conv.id)!.sandbox.name;

      // reconcile fails twice (transient 429), then succeeds.
      let attempts = 0;
      const prov2 = fakeProvisioner();
      prov2.reconcile = vi.fn(async () => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error("storage is (re)initializing"), { code: 429 });
        return [{ ref: { name: sandboxName, namespace: "ns" }, running: true }];
      });
      const m2 = createSessionManager({ provisioner: prov2, store: createFileConversationStore(root) });
      await m2.hydrate();

      expect(attempts).toBe(3); // retried past the two failures
      // The map is CORRECT (running, real ref) despite the initial failures — NOT
      // the empty-map / assume-suspended fallback.
      expect(m2.get(conv.id)?.status).toBe("running");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrate keeps a SUSPENDED Sandbox's real ref so revive RESUMES it (not create -> 409)", async () => {
    // Bug: reconcile() reported a suspended Sandbox (replicas unset/0) as
    // running:false, and hydrateEntry threw away its namespace (namespace: "").
    // revive() then read the empty namespace as "never existed" and called
    // create() -> 409 AlreadyExists against the still-present suspended CRD.
    // A suspended Sandbox EXISTS on the cluster, so revive() must resume() it.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("delta");
      const sandboxName = m1.get(conv.id)!.sandbox.name;

      // Fresh "process": the Sandbox still EXISTS but is SUSPENDED (running:false).
      const prov2 = fakeProvisioner();
      prov2.reconcile = vi.fn(async () => [
        { ref: { name: sandboxName, namespace: "ns" }, running: false },
      ]);
      const m2 = createSessionManager({ provisioner: prov2, store: createFileConversationStore(root) });
      await m2.hydrate();

      // Suspended, but its real ref (with namespace) is retained — not "".
      expect(m2.get(conv.id)?.status).toBe("suspended");
      expect(m2.get(conv.id)?.sandbox).toMatchObject({ name: sandboxName, namespace: "ns" });

      // Reviving RESUMES the existing Sandbox; it must NOT create() a duplicate.
      await m2.revive(conv.id);
      expect(prov2.resume).toHaveBeenCalledOnce();
      expect(prov2.create).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrate marks a GONE Sandbox (absent from reconcile) suspended, and revive re-creates it", async () => {
    // The other side of the fix: if a conversation's Sandbox is NOT on the
    // cluster at all (GC'd / never resumed), revive() must create() from scratch.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("epsilon");

      // Fresh "process": reconcile finds NO Sandbox for this conversation.
      const prov2 = fakeProvisioner();
      prov2.reconcile = vi.fn(async () => []);
      const m2 = createSessionManager({ provisioner: prov2, store: createFileConversationStore(root) });
      await m2.hydrate();

      expect(m2.get(conv.id)?.status).toBe("suspended");
      await m2.revive(conv.id);
      expect(prov2.create).toHaveBeenCalledOnce();
      expect(prov2.resume).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prompting a hydrated-but-running conversation revives it (builds the bridge)", async () => {
    // Regression: hydrate() marks a still-running conversation 'running' (pod up)
    // but it has NO bridge in this process. prompt() must revive on !bridge — NOT
    // gate revive on status!=="running", or bridge?.prompt() silently no-ops and
    // the agent never runs (the second-!scooter-does-nothing symptom).
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("delta");
      const sandboxName = m1.get(conv.id)!.sandbox.name;

      // Fresh process: a recording bridge so we can see prompt() reach it.
      const prompts: string[] = [];
      const bridgeFactory = () =>
        ({
          start: vi.fn(async () => {}),
          prompt: vi.fn(async ({ text }: { text: string }) => {
            prompts.push(text);
            return "run-x";
          }),
          stop: vi.fn(async () => {}),
          onEvent: () => () => {},
          onPersist: () => () => {},
          onTitle: () => () => {},
        }) as never;
      const prov2 = fakeProvisioner();
      prov2.reconcile = vi.fn(async () => [
        { ref: { name: sandboxName, namespace: "ns" }, running: true },
      ]);
      const m2 = createSessionManager({
        provisioner: prov2,
        store: createFileConversationStore(root),
        bridgeFactory,
      });
      await m2.hydrate();
      expect(m2.get(conv.id)?.status).toBe("running"); // pod up, but no bridge

      // The webhook path: prompt the existing conversation by thread id.
      await m2.promptByThread("delta", "second !scooter mention");

      // It revived (built the bridge) and the prompt reached the agent.
      expect(prompts).toContain("second !scooter mention");
      // Let the fire-and-forget activity write settle before teardown deletes the
      // store dir (else a late recordActivity mkdir races rmSync -> ENOENT).
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("promptByThread continues a PERSISTED conversation even when hydrate() didn't run (no orphaned duplicate)", async () => {
    // The restart-orphan bug: after an agent-host restart, a webhook follow-up
    // hits promptByThread with a threadId that's in the STORE but not yet in the
    // in-memory map (hydrate raced/failed/evicted). It must reconstruct + CONTINUE
    // the existing conversation — NOT blind-create a duplicate that orphans the
    // persisted event log. This mirrors the real failure: NO hydrate() call.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("echo");
      const originalId = conv.id;
      const sandboxName = m1.get(conv.id)!.sandbox.name;
      // A distinctive title + createdAt: a BLIND-create would reset these (new
      // "New chat" entry, fresh createdAt) while CONTINUING preserves them — that's
      // the observable proxy for "same conversation, event log intact" (the id is
      // the threadId either way, so id-equality alone can't tell them apart).
      await m1.setTitle(originalId, "The Original Conversation");
      const originalCreatedAt = m1.get(originalId)!.createdAt;
      await new Promise((r) => setTimeout(r, 25)); // settle saveMeta + a clock gap

      // Fresh "process": a new manager over the SAME store, with a recording bridge.
      // Deliberately DO NOT call hydrate() — the in-memory map is empty.
      const prompts: string[] = [];
      const bridgeFactory = () =>
        ({
          start: vi.fn(async () => {}),
          prompt: vi.fn(async ({ text }: { text: string }) => {
            prompts.push(text);
            return "run-y";
          }),
          stop: vi.fn(async () => {}),
          onEvent: () => () => {},
          onPersist: () => () => {},
          onTitle: () => () => {},
        }) as never;
      const prov2 = fakeProvisioner();
      prov2.reconcile = vi.fn(async () => [
        { ref: { name: sandboxName, namespace: "ns" }, running: true },
      ]);
      const m2 = createSessionManager({
        provisioner: prov2,
        store: createFileConversationStore(root),
        bridgeFactory,
      });
      // No hydrate() — the map is empty.
      expect(m2.list().length).toBe(0);

      await m2.promptByThread("echo", "follow-up after restart");

      // It CONTINUED the same conversation (not a blind-create): the prompt reached
      // the agent, and the persisted title + createdAt are preserved. A blind-create
      // would show title "New chat" and a newer createdAt (orphaning the original).
      expect(prompts).toContain("follow-up after restart");
      const revived = m2.get(originalId)!;
      expect(revived.title).toBe("The Original Conversation");
      expect(revived.createdAt).toBe(originalCreatedAt);
      expect(m2.list().length).toBe(1);
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("promptByThread with a NEW model rebuilds the bridge with that model + persists it", async () => {
    // Per-conversation model is switchable mid-conversation: passing a model to
    // promptByThread that differs from the conversation's current model must tear
    // down the live bridge and rebuild it with the new model (so goose relaunches
    // with the new GOOSE_MODEL), and persist it so a restart keeps the switch.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const built: Array<string | undefined> = [];
      const stops: number[] = [];
      const bridgeFactory = ({ model }: { model?: string }) => {
        built.push(model);
        return {
          start: vi.fn(async () => {}),
          prompt: vi.fn(async () => "run-x"),
          stop: vi.fn(async () => {
            stops.push(1);
          }),
          onEvent: () => () => {},
          onPersist: () => () => {},
          onTitle: () => () => {},
        } as never;
      };
      const store = createFileConversationStore(root);
      const m = createSessionManager({ provisioner: fakeProvisioner(), store, bridgeFactory });

      await m.start("t1", "opus"); // initial model
      expect(built).toEqual(["opus"]);

      // Same model -> no rebuild.
      await m.promptByThread("t1", "hello", "opus");
      expect(built).toEqual(["opus"]);

      // New model -> stop old bridge + rebuild with the new model.
      await m.promptByThread("t1", "now switch", "sonnet");
      expect(stops.length).toBe(1);
      expect(built).toEqual(["opus", "sonnet"]);
      expect(m.get("t1")?.model).toBe("sonnet");

      // Persisted: a fresh process hydrates the switched model.
      const m2 = createSessionManager({
        provisioner: fakeProvisioner(),
        store: createFileConversationStore(root),
      });
      await m2.hydrate();
      expect(m2.get("t1")?.model).toBe("sonnet");
      await new Promise((r) => setTimeout(r, 20)); // settle fire-and-forget writes
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ended conversations do NOT come back after a restart (persisted state removed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      await m1.start("keep");
      const gone = await m1.start("gone");
      await m1.end(gone.id);
      expect(m1.list().map((c) => c.id)).toEqual(["keep"]); // gone is GC'd now

      // A fresh process hydrates from disk: the ended conversation must be gone,
      // not resurrected as a "suspended" tombstone.
      const m2 = createSessionManager({
        provisioner: fakeProvisioner(),
        store: createFileConversationStore(root),
      });
      await m2.hydrate();
      expect(m2.list().map((c) => c.id)).toEqual(["keep"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records last-activity metadata and persists it via the store", async () => {
    const provisioner = fakeProvisioner();
    const store = inMemoryStore();
    store.recordActivity = vi.fn(async () => {});
    const sessions = createSessionManager({ provisioner, store });

    const conv = await sessions.start("thread-1");
    const t0 = sessions.get(conv.id)!.lastActivityAt;
    expect(t0).toBeGreaterThan(0);

    await sessions.promptByThread("thread-1", "hello");

    expect(sessions.get(conv.id)!.lastActivityAt).toBeGreaterThanOrEqual(t0);
    expect(store.recordActivity).toHaveBeenCalledWith(conv.id, expect.any(Number));
  });

  it("sweepIdle() suspends only running conversations idle past the threshold", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const provisioner = fakeProvisioner();
      const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
      const idle = await sessions.start("idle-thread"); // stamped at t=0

      vi.setSystemTime(9 * 60_000); // 9 min later
      const fresh = await sessions.start("fresh-thread"); // stamped at t=9min

      // At t=10min, idle is 10min old, fresh is 1min old; threshold is 5min.
      const suspended = await sessions.sweepIdle(5 * 60_000, 10 * 60_000);

      expect(suspended).toEqual([idle.id]);
      expect(sessions.get(idle.id)?.status).toBe("suspended");
      expect(sessions.get(fresh.id)?.status).toBe("running");
      expect(provisioner.suspend).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweepIdle() ignores already-suspended conversations", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const conv = await sessions.start("thread-1");
    await sessions.suspend(conv.id);
    (provisioner.suspend as ReturnType<typeof vi.fn>).mockClear();

    // idleMs 0 + now in the future → everything "idle", but only running ones sweep.
    const suspended = await sessions.sweepIdle(0, conv.lastActivityAt + 1);

    expect(suspended).toEqual([]);
    expect(provisioner.suspend).not.toHaveBeenCalled();
  });

  it("resumeInterrupted revives + nudges ONLY conversations with a dangling run", async () => {
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      // First process: create two conversations, each with one completed run in
      // the log, then leave ONE with a dangling run (RUN_STARTED, no RUN_FINISHED).
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const done = await m1.start("clean-thread");
      const cut = await m1.start("interrupted-thread");
      // A completed run for the clean one:
      await store1.appendEvent(done.id, { type: "RUN_STARTED", threadId: "clean-thread", runId: "r1" });
      await store1.appendEvent(done.id, { type: "RUN_FINISHED", threadId: "clean-thread", runId: "r1" });
      // A DANGLING run for the interrupted one (started, never finished):
      await store1.appendEvent(cut.id, { type: "RUN_STARTED", threadId: "interrupted-thread", runId: "r1" });
      await store1.appendEvent(cut.id, { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "working" });

      // Fresh process: a recording bridge to see which conversations get prompted.
      const prompted: Array<{ id: string; text: string }> = [];
      const bridgeFactory = (args: { conversationId: string }) =>
        ({
          start: vi.fn(async () => {}),
          prompt: vi.fn(async ({ text }: { text: string }) => {
            prompted.push({ id: args.conversationId, text });
            return "run-x";
          }),
          stop: vi.fn(async () => {}),
          onEvent: () => () => {},
          onPersist: () => () => {},
          onTitle: () => () => {},
        }) as never;
      const m2 = createSessionManager({
        provisioner: fakeProvisioner(),
        store: createFileConversationStore(root),
        bridgeFactory,
      });
      await m2.hydrate();

      const resumed = await m2.resumeInterrupted();

      // Only the interrupted conversation was resumed, with the nudge (not the
      // clean one, and not the user's literal prompt).
      expect(resumed).toEqual([cut.id]);
      expect(prompted.map((p) => p.id)).toEqual([cut.id]);
      expect(prompted[0].text).toMatch(/interrupted by a restart/i);
      expect(prompted[0].text).toMatch(/continue/i); // a nudge, not the user's prompt
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
