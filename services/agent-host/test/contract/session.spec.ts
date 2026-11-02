/**
 * Contract test for the SessionManager lifecycle against a fake provisioner and
 * store: start (cold sandbox), prompt, suspend (keep the handle), revive (replay
 * the event log), end.
 */

import { beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSessionManager,
  UnknownConversationError,
  type SandboxProvisioner,
  type ConversationStore,
  type RouterMeta,
} from "../../src/session/manager.js";
import { noopRegistry } from "../../src/session/conversationRegistry.js";
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

/** Star and title as the conversation-router writes them to the row. */
const routerRows = new Map<SessionId, Partial<RouterMeta>>();
const routerWrite = (id: SessionId, patch: Partial<RouterMeta>) =>
  routerRows.set(id, { ...routerRows.get(id), ...patch });

const inMemoryStore = (): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    readRouterMeta: async (id) => routerRows.get(id),
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
  beforeEach(() => routerRows.clear());

  it("start() provisions a cold sandbox and a running conversation", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });

    const conv = await sessions.start("thread-1");

    expect(provisioner.create).toHaveBeenCalledOnce();
    // A new sandbox is named by the full id, which the broker reads back off its ServiceAccount.
    const [nameId, urlThread] = (provisioner.create as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(urlThread).toBe("thread-1");
    expect(nameId).toBe("thread-1");
    expect(conv.status).toBe("running");
    expect(conv.sandbox.name).toBe("conv-thread-1");
  });

  it("registers the conversation BEFORE the (slow) sandbox provisioning finishes", async () => {
    // The UI opens events.integrity right after POST /agui, so the conversation must be get()-able from the moment start() begins provisioning.
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
    // The UI would hit events.integrity now, so the conversation must already exist.
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

  it("suspend() publishes phase=Suspended to the row when we OWN the conversation", async () => {
    const setPhase = vi.fn(async () => {});
    const registry = { register: vi.fn(async () => {}), setPhase };
    // A guard that always allows, as the owner.
    const guard = { observe: () => {}, canWrite: () => true };
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(), store: inMemoryStore(),
      conversationRegistry: registry, ownershipGuard: guard as never,
    });
    const conv = await sessions.start("thread-1");
    await sessions.suspend(conv.id);
    await sessions.revive(conv.id);
    // Both liveness transitions were published.
    expect(setPhase).toHaveBeenCalledWith(conv.id, "Suspended");
    expect(setPhase).toHaveBeenCalledWith(conv.id, "Assigned");
  });

  it("suspend() does NOT publish phase when we are NOT the owner (fenced)", async () => {
    const setPhase = vi.fn(async () => {});
    const registry = { register: vi.fn(async () => {}), setPhase };
    const guard = { observe: () => {}, canWrite: () => false }; // not owner
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(), store: inMemoryStore(),
      conversationRegistry: registry, ownershipGuard: guard as never,
    });
    const conv = await sessions.start("thread-1");
    await sessions.suspend(conv.id);
    expect(setPhase).not.toHaveBeenCalled();
  });

  it("revive() RE-REGISTERS the row (self-heals a conversation whose row was lost/never made)", async () => {
    const order: string[] = [];
    const register = vi.fn(async () => {
      order.push("register");
    });
    const registry = { register, setPhase: vi.fn(async () => {}) };
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(), store: inMemoryStore(), conversationRegistry: registry,
    });
    const conv = await sessions.start("thread-1"); // register #1 (start)
    await sessions.suspend(conv.id);
    register.mockClear();
    await sessions.revive(conv.id);
    // revive() re-registers idempotently so a row lost across a restart is re-created.
    expect(register).toHaveBeenCalledWith(conv.id, expect.objectContaining({ sandboxRef: expect.any(String) }));
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

  it("revive() registers activity so the idle sweep does NOT immediately re-suspend it", async () => {
    // revive() must touch() the entry so the freshly started pod gets the full idle window.
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const conv = await sessions.start("thread-1");
    await sessions.suspend(conv.id);

    // A sweep with a 60s idle window run right after the revive must not suspend it.
    const revived = await sessions.revive(conv.id);
    const reviveAt = revived.lastActivityAt;
    const swept = await sessions.sweepIdle(60_000, reviveAt + 1_000); // 1s later
    expect(swept).not.toContain(conv.id);
    expect(sessions.get(conv.id)?.status).toBe("running");

    // It is eligible once genuinely idle past the window.
    const sweptLater = await sessions.sweepIdle(60_000, reviveAt + 61_000);
    expect(sweptLater).toContain(conv.id);
  });

  it("sweepIdle does NOT suspend a conversation with a RUNNING background job", async () => {
    // lastActivityAt is not bumped while a background job runs, so sweepIdle must consult hasRunningBackgroundJob to keep the pod up.
    const provisioner = fakeProvisioner();
    let jobRunning = true;
    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      hasRunningBackgroundJob: async (_id) => jobRunning,
    });
    const conv = await sessions.start("thread-1");
    const idleAt = sessions.get(conv.id)!.lastActivityAt + 61_000; // well past a 60s window

    // The job is still running, so it is not swept despite being idle by lastActivityAt.
    expect(await sessions.sweepIdle(60_000, idleAt)).not.toContain(conv.id);
    expect(sessions.get(conv.id)?.status).toBe("running");

    // Once the job finishes it is eligible for suspend.
    jobRunning = false;
    expect(await sessions.sweepIdle(60_000, idleAt)).toContain(conv.id);
  });

  it("sweepIdle suspends normally when the job check is absent or fails (fail-open)", async () => {
    // The job check is best-effort, so a missing or throwing hook must never pin a pod up.
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      hasRunningBackgroundJob: async () => {
        throw new Error("exec probe failed");
      },
    });
    const conv = await sessions.start("thread-1");
    const idleAt = sessions.get(conv.id)!.lastActivityAt + 61_000;
    expect(await sessions.sweepIdle(60_000, idleAt)).toContain(conv.id);
  });

  it("revive() calls onRevived (with a live bridge) so index.ts can re-raise dropped interrupts", async () => {
    // index.ts wires onRevived to re-raise pending broker approvals, so the hook must fire with the conversation id once the bridge is live.
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

    // The watcher injects with a priority and the "thinking" policy so it preempts idle thinking but never kills an in-flight tool call.
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

    // A priority @mention rides the "thinking" policy so it interrupts thinking but not a running tool call.
    await sessions.promptByThread("thread-1", "<@BOT> take a look", undefined, 10);
    expect(optsSeen.at(-1)).toEqual({ priority: 10, interrupt: "thinking" });

    // A normal prompt waits its turn with no priority or interrupt opts.
    await sessions.promptByThread("thread-1", "just a heads up", undefined, undefined);
    expect(optsSeen.at(-1)).toBeUndefined();
  });

  it("enqueueByThread() resolves once the prompt is queued, not when its run ends", async () => {
    // The bridge settles prompt() only when the run finishes; this one never does.
    let finish: (id: string) => void = () => {};
    const prompt = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const bridgeFactory = () =>
      ({
        start: vi.fn(async () => {}),
        prompt,
        stop: vi.fn(async () => {}),
        onEvent: () => () => {},
        onPersist: () => () => {},
        onTitle: () => () => {},
      }) as never;
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore(), bridgeFactory });
    await sessions.start("thread-1");

    // POST /messages answers here; a caller that timed out on a long run would resend.
    await sessions.enqueueByThread("thread-1", "a reviewer answered");
    expect(prompt).toHaveBeenCalledTimes(1);
    finish("run-x");

    // Finding the conversation still fails loudly.
    await expect(sessions.enqueueByThread("never-created", "hi")).rejects.toThrow(UnknownConversationError);
  });

  it("promptByThread() REFUSES an unknown thread instead of creating one", async () => {
    const bridgeFactory = () =>
      ({
        start: vi.fn(async () => {}),
        prompt: vi.fn(async () => "run-x"),
        stop: vi.fn(async () => {}),
        onEvent: () => () => {},
        onPersist: () => () => {},
        onTitle: () => () => {},
      }) as never;
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore(), bridgeFactory });

    // Conversations are created by the router, never implicitly from a caller-chosen threadId.
    await expect(
      sessions.promptByThread("never-created", "hi from slack", undefined, undefined, "user-alice"),
    ).rejects.toThrow(UnknownConversationError);

    // Nothing was created as a side effect.
    expect(sessions.list()).toHaveLength(0);
    expect(provisioner.create).not.toHaveBeenCalled();
  });

  it("promptByThread() ADOPTS a conversation that exists only as a row (create-then-prompt race)", async () => {
    // The router returns the id before assignment, so a prompt can reach a pod whose local store has never seen it and the row is adopted as the authority for existence.
    const prompt = vi.fn(async () => "run-x");
    const bridgeFactory = () =>
      ({
        start: vi.fn(async () => {}),
        prompt,
        stop: vi.fn(async () => {}),
        onEvent: () => () => {},
        onPersist: () => () => {},
        onTitle: () => () => {},
      }) as never;
    // The order of register against the slow sandbox provisioning is what matters, since register fires either way.
    const order: string[] = [];
    const register = vi.fn(async () => {
      order.push("register");
    });
    const conversationRegistry = {
      ...noopRegistry,
      register,
      get: vi.fn(async (id: string) => ({
        id,
        // No sandboxRef, because the router creates the row without provisioning.
        spec: { owner: "user-alice", model: "sonnet" },
      })),
    } as never;
    const baseProvisioner = fakeProvisioner();
    const provisioner = {
      ...baseProvisioner,
      create: vi.fn(async (...args: never[]) => {
        order.push("provision");
        return (baseProvisioner.create as never as (...a: never[]) => never)(...args);
      }),
    } as never;
    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      bridgeFactory,
      conversationRegistry,
    });

    const threadId = "created-by-the-router";
    await expect(
      sessions.promptByThread(threadId, "first message", undefined, undefined, "user-alice"),
    ).resolves.not.toThrow();

    // The entry carries the row's spec.
    const [conv] = sessions.list();
    expect(conv.threadId).toBe(threadId);
    expect(conv.owner).toBe("user-alice");
    // The prompt reached the bridge.
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, text: "first message" }),
      undefined,
    );

    // The router derives its routing short-id from spec.sandboxRef, so it must be published on adoption rather than after the sandbox boots.
    expect(register).toHaveBeenCalledWith(
      threadId,
      expect.objectContaining({ sandboxRef: expect.stringMatching(/^conv-/) }),
    );
    expect(order[0]).toBe("register");
    expect(order).toContain("provision");
  });

  it("promptByThread() prompts an EXISTING thread and leaves its owner alone", async () => {
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

    // Created explicitly, owned by alice.
    const conv = await sessions.start("wh-thread", undefined, "user-alice");

    // The owner is stamped only at creation, so a follow-up carrying a different owner does not change it.
    await sessions.promptByThread("wh-thread", "follow up", undefined, undefined, "user-bob");
    expect(sessions.get(conv.id)?.owner).toBe("user-alice");
  });

  it("end() destroys the sandbox and GCs the conversation", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
    const conv = await sessions.start("thread-1");

    await sessions.end(conv.id);

    expect(provisioner.destroy).toHaveBeenCalledOnce();
    // An ended conversation is removed from the list and its persisted state, so it no longer resolves.
    expect(sessions.get(conv.id)).toBeUndefined();
    expect(sessions.list()).toHaveLength(0);
  });

  it("the file store dedups + persists external resource links", async () => {
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      await store1.addLink!("c1", { source: "github", resourceType: "pull_request", url: "https://gh/pr/1", title: "PR #1" });
      // The same link again is deduped.
      await store1.addLink!("c1", { source: "github", resourceType: "pull_request", url: "https://gh/pr/1", title: "PR #1" });
      await store1.addLink!("c1", { source: "slack", resourceType: "thread", title: "#eng thread" });
      expect(await store1.listLinks!("c1")).toHaveLength(2);

      // A fresh store over the same dir sees the persisted links.
      const store2 = createFileConversationStore(root);
      const links = await store2.listLinks!("c1");
      expect(links.map((l) => l.source).sort()).toEqual(["github", "slack"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  describe("user title precedence + starring", () => {
    it("setTitle (agent <title>) sets the title while the conversation is agent-titled", async () => {
      const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
      await sessions.start("t");
      await sessions.setTitle("t", "Agent's guess");
      expect(sessions.get("t")?.title).toBe("Agent's guess");
    });

    it("a user rename LOCKS the title — the agent's <title> can no longer overwrite it", async () => {
      const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
      await sessions.start("t");
      await sessions.setTitle("t", "Agent's guess"); // agent titled it first
      routerWrite("t" as SessionId, { title: "My name for this", userTitled: true });
      await sessions.refreshRouterMeta("t" as SessionId);
      expect(sessions.get("t")?.title).toBe("My name for this");
      expect(sessions.get("t")?.userTitled).toBe(true);

      // A later agent title is ignored because the user's rename wins permanently.
      await sessions.setTitle("t", "Agent's new guess");
      expect(sessions.get("t")?.title).toBe("My name for this");
    });

    it("the <title> marker names a conversation ONCE — a second marker is ignored", async () => {
      const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
      await sessions.start("t");
      await sessions.setTitle("t", "First reply's title");
      // A revive, a model switch or a BYO reconnect all make the agent open a "first" reply
      // again; none of them may retitle a conversation the user has been reading under its name.
      await sessions.setTitle("t", "Second reply's title");
      expect(sessions.get("t")?.title).toBe("First reply's title");
    });

    it("force (set_conversation_title) overrides the name-once gate", async () => {
      const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
      await sessions.start("t");
      await sessions.setTitle("t", "First reply's title");
      await sessions.setTitle("t", "The subject really changed", { force: true });
      expect(sessions.get("t")?.title).toBe("The subject really changed");
    });

    it("force does NOT override the user's own rename", async () => {
      const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
      await sessions.start("t");
      routerWrite("t" as SessionId, { title: "My name for this", userTitled: true });
      await sessions.setTitle("t", "Agent's idea", { force: true });
      expect(sessions.get("t")?.title).toBe("My name for this");
    });

    it("refreshRouterMeta pulls in the router's star and unstar", async () => {
      const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
      await sessions.start("t");
      routerWrite("t" as SessionId, { starred: true });
      await sessions.refreshRouterMeta("t" as SessionId);
      expect(sessions.get("t")?.starred).toBe(true);
      routerWrite("t" as SessionId, { starred: false });
      await sessions.refreshRouterMeta("t" as SessionId);
      expect(sessions.get("t")?.starred).toBe(false);
    });

    it("refreshRouterMeta leaves fields the read omits unchanged", async () => {
      const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
      await sessions.start("t");
      routerWrite("t" as SessionId, { title: "Mine", userTitled: true, starred: true });
      await sessions.refreshRouterMeta("t" as SessionId);
      routerRows.set("t" as SessionId, { visibility: "private", starred: undefined });
      await sessions.refreshRouterMeta("t" as SessionId);
      expect(sessions.get("t")).toMatchObject({ title: "Mine", userTitled: true, starred: true, visibility: "private" });
    });
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

      // Second "process": a fresh manager over the same store must repopulate the list from disk.
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

  it("hydrate publishes phase=Suspended for a conversation hydrated as suspended (self-heal)", async () => {
    // phase is otherwise written only at the suspend()/revive() transitions, so hydrate() re-publishes Suspended for any conversation it hydrates as suspended.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      await m1.start("alpha");

      const setPhase = vi.fn(async () => {});
      const registry = { register: vi.fn(async () => {}), setPhase };
      const guard = { canWrite: () => true };
      const store2 = createFileConversationStore(root);
      const m2 = createSessionManager({
        provisioner: fakeProvisioner(), store: store2,
        conversationRegistry: registry, ownershipGuard: guard as never,
      });
      await m2.hydrate();
      // alpha hydrates as suspended because the fake reconcile reports no running pod.
      expect(setPhase).toHaveBeenCalledWith("alpha", "Suspended");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrate reconciles a still-running Sandbox as running so the idle sweep reclaims it", async () => {
    // A Sandbox whose pod is still up after a restart must be tracked as running so sweepIdle can reclaim it.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("gamma");
      const sandboxName = m1.get(conv.id)!.sandbox.name; // conv-<shortId>

      // Fresh "process": its provisioner reports that conv's pod is still running.
      const prov2 = fakeProvisioner();
      prov2.reconcile = vi.fn(async () => [
        { ref: { name: sandboxName, namespace: "ns" }, running: true },
      ]);
      const m2 = createSessionManager({ provisioner: prov2, store: createFileConversationStore(root) });
      await m2.hydrate();

      // Reconciled as running, with the real namespace.
      expect(m2.get(conv.id)?.status).toBe("running");

      // The idle sweep can now suspend it.
      const swept = await m2.sweepIdle(0); // 0 idle threshold -> everything idle
      expect(swept).toContain(conv.id);
      expect(prov2.suspend).toHaveBeenCalledOnce();
      expect(m2.get(conv.id)?.status).toBe("suspended");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrate RETRIES a transient reconcile failure (rides out a boot apiserver blip)", async () => {
    // A transient apiserver error during reconcile must be retried rather than hydrating an empty map.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("delta");
      const sandboxName = m1.get(conv.id)!.sandbox.name;

      // reconcile fails twice with a transient 429, then succeeds.
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
      // The map is correct despite the initial failures.
      expect(m2.get(conv.id)?.status).toBe("running");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrate keeps a SUSPENDED Sandbox's real ref so revive RESUMES it (not create -> 409)", async () => {
    // A suspended Sandbox still exists on the cluster, so revive() must resume() it rather than create() a duplicate.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("delta");
      const sandboxName = m1.get(conv.id)!.sandbox.name;

      // Fresh "process": the Sandbox still exists but is suspended.
      const prov2 = fakeProvisioner();
      prov2.reconcile = vi.fn(async () => [
        { ref: { name: sandboxName, namespace: "ns" }, running: false },
      ]);
      const m2 = createSessionManager({ provisioner: prov2, store: createFileConversationStore(root) });
      await m2.hydrate();

      // Suspended, with its real ref and namespace retained.
      expect(m2.get(conv.id)?.status).toBe("suspended");
      expect(m2.get(conv.id)?.sandbox).toMatchObject({ name: sandboxName, namespace: "ns" });

      // Reviving resumes the existing Sandbox without creating a duplicate.
      await m2.revive(conv.id);
      expect(prov2.resume).toHaveBeenCalledOnce();
      expect(prov2.create).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hydrate marks a GONE Sandbox (absent from reconcile) suspended, and revive re-creates it", async () => {
    // A conversation whose Sandbox is absent from the cluster must be re-created by revive().
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("epsilon");

      // Fresh "process": reconcile finds no Sandbox for this conversation.
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
    // A conversation hydrated as running has no bridge in this process, so prompt() must revive on a missing bridge rather than on status.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("delta");
      const sandboxName = m1.get(conv.id)!.sandbox.name;

      // Fresh process: a recording bridge shows whether prompt() reaches it.
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

      // It built the bridge and the prompt reached the agent.
      expect(prompts).toContain("second !scooter mention");
      // Let the fire-and-forget activity write settle before teardown deletes the store dir.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("promptByThread continues a PERSISTED conversation even when hydrate() didn't run (no orphaned duplicate)", async () => {
    // A threadId that is in the store but not the in-memory map must be reconstructed and continued, not blind-created as a duplicate.
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const conv = await m1.start("echo");
      const originalId = conv.id;
      const sandboxName = m1.get(conv.id)!.sandbox.name;
      // A distinctive title and createdAt are the observable proxy for continuing the same conversation, since the id is the threadId either way.
      await m1.setTitle(originalId, "The Original Conversation");
      const originalCreatedAt = m1.get(originalId)!.createdAt;
      await new Promise((r) => setTimeout(r, 25)); // settle saveMeta + a clock gap

      // Fresh "process": a new manager over the same store, deliberately without hydrate().
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
      // The map is empty without hydrate().
      expect(m2.list().length).toBe(0);

      await m2.promptByThread("echo", "follow-up after restart");

      // The prompt reached the agent and the persisted title and createdAt are preserved.
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
    // A different model on promptByThread must rebuild the live bridge with it and persist the switch.
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

      // The same model does not rebuild.
      await m.promptByThread("t1", "hello", "opus");
      expect(built).toEqual(["opus"]);

      // A new model stops the old bridge and rebuilds with the new one.
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

      // A fresh process hydrating from disk must not resurrect the ended conversation.
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

  it("records last-activity metadata and persists it via saveMeta", async () => {
    // Activity is a field of the conversation record, persisted by the same saveMeta as every other meta change.
    const provisioner = fakeProvisioner();
    const store = inMemoryStore();
    const saveMeta = vi.fn(async () => {});
    store.saveMeta = saveMeta;
    const sessions = createSessionManager({ provisioner, store });

    const conv = await sessions.start("thread-1");
    const t0 = sessions.get(conv.id)!.lastActivityAt;
    expect(t0).toBeGreaterThan(0);

    saveMeta.mockClear();
    await sessions.promptByThread("thread-1", "hello");

    expect(sessions.get(conv.id)!.lastActivityAt).toBeGreaterThanOrEqual(t0);
    // The touch persisted a meta record carrying this conversation's lastActivityAt.
    expect(saveMeta).toHaveBeenCalledWith(
      expect.objectContaining({ id: conv.id, lastActivityAt: expect.any(Number) }),
    );
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

  it("touchById() keeps a conversation from being idle-swept (web-service traffic)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const provisioner = fakeProvisioner();
      const store = inMemoryStore();
      const saveMeta = vi.fn(async () => {});
      store.saveMeta = saveMeta;
      const sessions = createSessionManager({ provisioner, store });
      const conv = await sessions.start("web-thread"); // stamped at t=0

      // The proxy touches at t=9min while a user is using the pod's web services.
      vi.setSystemTime(9 * 60_000);
      sessions.touchById(conv.id);
      // The touch is persisted as part of the conversation's meta record.
      expect(saveMeta).toHaveBeenCalledWith(
        expect.objectContaining({ id: conv.id, lastActivityAt: 9 * 60_000 }),
      );

      // At t=10min with a 5min threshold the touch leaves it only 1min idle, so it is not swept.
      const suspended = await sessions.sweepIdle(5 * 60_000, 10 * 60_000);
      expect(suspended).toEqual([]);
      expect(sessions.get(conv.id)?.status).toBe("running");
    } finally {
      vi.useRealTimers();
    }
  });

  it("touchById() records activity in the shared store, even on a replica without the conversation", async () => {
    const store = inMemoryStore();
    const touchActivity = vi.fn(async () => {});
    store.touchActivity = touchActivity;
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store });
    // A proxied WebSocket stays on the replica it connected through after ownership moves.
    sessions.touchById("held-elsewhere" as never);
    expect(touchActivity).toHaveBeenCalledWith("held-elsewhere", expect.any(Number));
  });

  it("sweepIdle() spares a conversation whose shared lastActivityAt another replica raised", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const provisioner = fakeProvisioner();
      const store = inMemoryStore();
      // Another replica's proxy touched it at t=9min; this owner never saw the traffic.
      store.readLastActivity = vi.fn(async () => 9 * 60_000);
      const sessions = createSessionManager({ provisioner, store });
      const conv = await sessions.start("vscode-thread"); // stamped at t=0

      expect(await sessions.sweepIdle(5 * 60_000, 10 * 60_000)).toEqual([]);
      expect(sessions.get(conv.id)?.status).toBe("running");
      // Once that activity is itself past the window, the sweep suspends as usual.
      expect(await sessions.sweepIdle(5 * 60_000, 15 * 60_000)).toEqual([conv.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweepIdle() falls back to local activity when the shared read fails", async () => {
    const store = inMemoryStore();
    store.readLastActivity = vi.fn(async () => { throw new Error("pg down"); });
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store });
    const conv = await sessions.start("t");
    expect(await sessions.sweepIdle(1, Date.now() + 60_000)).toEqual([conv.id]);
  });

  it("touchById() is a no-op for an unknown conversation", () => {
    const sessions = createSessionManager({ provisioner: fakeProvisioner(), store: inMemoryStore() });
    expect(() => sessions.touchById("nope" as never)).not.toThrow();
  });

  it("sweepIdle() does NOT suspend a conversation with a run IN FLIGHT (a long turn > idle window)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      // A bridge whose queueState can be flipped to "running" models goose mid-turn.
      let running = false;
      const bridgeFactory = () =>
        ({
          start: vi.fn(async () => {}),
          prompt: vi.fn(async () => "run-x"),
          stop: vi.fn(async () => {}),
          onEvent: () => () => {},
          onPersist: () => () => {},
          onTitle: () => () => {},
          queueState: () => ({ running, currentRunMs: running ? 1000 : 0, queued: 0, maxQueuedPriority: 0 }),
        }) as never;
      const provisioner = fakeProvisioner();
      const sessions = createSessionManager({ provisioner, store: inMemoryStore(), bridgeFactory });

      const conv = await sessions.start("busy-thread"); // stamped at t=0
      await sessions.revive(conv.id); // attach the live bridge
      running = true; // a long agent turn is now in flight

      // Well past the idle window with a stale lastActivityAt, the in-flight-run guard must keep the pod up.
      const swept = await sessions.sweepIdle(5 * 60_000, 60 * 60_000); // 1h later, 5m threshold
      expect(swept).not.toContain(conv.id);
      expect(sessions.get(conv.id)?.status).toBe("running");
      expect(provisioner.suspend).not.toHaveBeenCalled();

      // Once the run finishes, the same stale-idle conversation is reclaimed.
      running = false;
      const sweptAfter = await sessions.sweepIdle(5 * 60_000, 60 * 60_000);
      expect(sweptAfter).toContain(conv.id);
      expect(sessions.get(conv.id)?.status).toBe("suspended");
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweepIdle() does NOT suspend a conversation with QUEUED work (backlog behind the run)", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const bridgeFactory = () =>
        ({
          start: vi.fn(async () => {}),
          prompt: vi.fn(async () => "run-x"),
          stop: vi.fn(async () => {}),
          onEvent: () => () => {},
          onPersist: () => () => {},
          onTitle: () => () => {},
          // Not running between turns, but a queued prompt still counts as busy.
          queueState: () => ({ running: false, currentRunMs: 0, queued: 2, maxQueuedPriority: 0 }),
        }) as never;
      const provisioner = fakeProvisioner();
      const sessions = createSessionManager({ provisioner, store: inMemoryStore(), bridgeFactory });
      const conv = await sessions.start("queued-thread");
      await sessions.revive(conv.id);

      const swept = await sessions.sweepIdle(5 * 60_000, 60 * 60_000);
      expect(swept).not.toContain(conv.id);
      expect(provisioner.suspend).not.toHaveBeenCalled();
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

    // Everything is idle with idleMs 0, but only running conversations sweep.
    const suspended = await sessions.sweepIdle(0, conv.lastActivityAt + 1);

    expect(suspended).toEqual([]);
    expect(provisioner.suspend).not.toHaveBeenCalled();
  });

  describe("sweepRetention (auto-delete stale unstarred conversations)", () => {
    const DAY = 24 * 60 * 60 * 1000;

    it("reaps (end + destroy) a conversation inactive past the window", async () => {
      const provisioner = fakeProvisioner();
      const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
      const conv = await sessions.start("old"); // lastActivityAt = t0

      // 31 days later with a 30-day threshold it is stale.
      const reaped = await sessions.sweepRetention(30 * DAY, conv.lastActivityAt + 31 * DAY);

      expect(reaped).toEqual([conv.id]);
      expect(sessions.get(conv.id)).toBeUndefined(); // ended → dropped
      expect(provisioner.destroy).toHaveBeenCalledOnce();
    });

    it("EXEMPTS a starred conversation (the whole point of the star)", async () => {
      const provisioner = fakeProvisioner();
      const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
      const conv = await sessions.start("starred");
      routerWrite(conv.id, { starred: true });
      await sessions.refreshRouterMeta(conv.id);

      const reaped = await sessions.sweepRetention(30 * DAY, conv.lastActivityAt + 365 * DAY);

      expect(reaped).toEqual([]);
      expect(sessions.get(conv.id)?.status).toBe("running"); // untouched
      expect(provisioner.destroy).not.toHaveBeenCalled();
    });

    it("EXEMPTS a conversation the router starred behind this replica's back", async () => {
      const provisioner = fakeProvisioner();
      const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
      const conv = await sessions.start("starred-elsewhere"); // memory says unstarred
      routerWrite(conv.id, { starred: true });

      const reaped = await sessions.sweepRetention(30 * DAY, conv.lastActivityAt + 365 * DAY);

      expect(reaped).toEqual([]);
      expect(sessions.get(conv.id)?.starred).toBe(true);
      expect(provisioner.destroy).not.toHaveBeenCalled();
    });

    it("leaves a RECENTLY-active conversation alone (age is lastActivityAt, not createdAt)", async () => {
      const provisioner = fakeProvisioner();
      const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
      const conv = await sessions.start("recent");

      // Only 5 days since last activity against a 30-day threshold.
      const reaped = await sessions.sweepRetention(30 * DAY, conv.lastActivityAt + 5 * DAY);

      expect(reaped).toEqual([]);
      expect(sessions.get(conv.id)?.status).toBe("running");
    });

    it("reaps old + unstarred while sparing starred + recent in one sweep", async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const provisioner = fakeProvisioner();
        const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
        const old1 = await sessions.start("old1"); // t=0
        const old2 = await sessions.start("old2"); // t=0
        const starred = await sessions.start("starred"); // t=0
        routerWrite(starred.id, { starred: true });

        // A recent one, its lastActivityAt stamped at t=40d (near `now`).
        vi.setSystemTime(40 * DAY);
        const recent = await sessions.start("recent"); // t=40d

        // At t=40d with a 30d threshold old1/old2 are stale, starred is exempt and recent is 0d old.
        const reaped = await sessions.sweepRetention(30 * DAY, 40 * DAY);

        expect(reaped.sort()).toEqual([old1.id, old2.id].sort());
        expect(sessions.get(starred.id)?.status).toBe("running");
        expect(sessions.get(recent.id)?.status).toBe("running");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does NOT reap a stale conversation that has a LIVE subagent (shared pod)", async () => {
      const provisioner = fakeProvisioner();
      const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
      const parent = await sessions.start("parent");
      // Spawn a subagent sharing the parent's pod.
      await sessions.spawnChild(parent.id, "child-thread", { prompt: "do a thing" });

      // Even though the parent is old, reaping it would destroy the subagent's pod.
      const reaped = await sessions.sweepRetention(30 * DAY, parent.lastActivityAt + 40 * DAY);

      expect(reaped).toEqual([]);
      expect(sessions.get(parent.id)?.status).toBe("running");
      expect(provisioner.destroy).not.toHaveBeenCalled();
    });

    it("does not reap subagents on their own (they die with their parent)", async () => {
      const provisioner = fakeProvisioner();
      const sessions = createSessionManager({ provisioner, store: inMemoryStore() });
      const parent = await sessions.start("parent");
      const child = await sessions.spawnChild(parent.id, "child-thread", { prompt: "x" });

      // A subagent is never a reap candidate itself, so `child.id` never appears in the reaped list independently.
      const reaped = await sessions.sweepRetention(30 * DAY, parent.lastActivityAt + 40 * DAY);
      expect(reaped).not.toContain(child.id);
    });
  });

  it("resumeInterrupted revives + nudges ONLY conversations with a dangling run", async () => {
    const root = mkdtempSync(join(tmpdir(), "convstore-"));
    try {
      // First process: two conversations, one of them left with a dangling run.
      const store1 = createFileConversationStore(root);
      const m1 = createSessionManager({ provisioner: fakeProvisioner(), store: store1 });
      const done = await m1.start("clean-thread");
      const cut = await m1.start("interrupted-thread");
      // A completed run for the clean one:
      await store1.appendEvent(done.id, { type: "RUN_STARTED", threadId: "clean-thread", runId: "r1" });
      await store1.appendEvent(done.id, { type: "RUN_FINISHED", threadId: "clean-thread", runId: "r1" });
      // A dangling run for the interrupted one:
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

      // Only the interrupted conversation was resumed, with the nudge.
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


describe("sweepIdle is OWNER-ONLY (the zombie-sandbox bug)", () => {
  it("a non-owner neither suspends NOR probes an idle conversation", async () => {
    // The background-job exec probe rides the pollForReadyPod self-heal that resumes a sandbox, so a non-owner must not probe at all.
    const provisioner = fakeProvisioner();
    let probes = 0;
    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      hasRunningBackgroundJob: async () => {
        probes++;
        return false;
      },
      ownershipGuard: { canWrite: () => false }, // another pod owns everything
    });
    const conv = await sessions.start("thread-zombie");
    const idleAt = sessions.get(conv.id)!.lastActivityAt + 61_000;

    expect(await sessions.sweepIdle(60_000, idleAt)).not.toContain(conv.id);
    expect(probes, "a non-owner must not fire the exec probe — the probe is what resumes").toBe(0);
    expect((provisioner.suspend as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("an UNOBSERVED conversation (deleted through another pod) is neither suspended NOR probed", async () => {
    // Its row is gone so canWrite fails open, but the probe would recreate the deleted sandbox.
    const provisioner = fakeProvisioner();
    let probes = 0;
    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      hasRunningBackgroundJob: async () => {
        probes++;
        return false;
      },
      ownershipGuard: { canWrite: () => true, owns: () => false },
    });
    const conv = await sessions.start("thread-deleted-elsewhere");
    const idleAt = sessions.get(conv.id)!.lastActivityAt + 61_000;

    expect(await sessions.sweepIdle(60_000, idleAt)).not.toContain(conv.id);
    expect(probes, "an unobserved conversation must not be exec-probed").toBe(0);
    expect((provisioner.suspend as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("the cache says owned but the ROW disagrees: neither suspended NOR probed", async () => {
    const provisioner = fakeProvisioner();
    let probes = 0;
    const confirmOwns = vi.fn(async () => false);
    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      hasRunningBackgroundJob: async () => {
        probes++;
        return false;
      },
      ownershipGuard: { canWrite: () => true, owns: () => true, confirmOwns },
    });
    const conv = await sessions.start("thread-lagging-cache");
    const idleAt = sessions.get(conv.id)!.lastActivityAt + 61_000;

    expect(await sessions.sweepIdle(60_000, idleAt)).not.toContain(conv.id);
    expect(confirmOwns).toHaveBeenCalledWith(conv.id);
    expect(probes).toBe(0);
    expect((provisioner.suspend as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("the owner still sweeps normally", async () => {
    const provisioner = fakeProvisioner();
    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      ownershipGuard: { canWrite: () => true },
    });
    const conv = await sessions.start("thread-owned");
    const idleAt = sessions.get(conv.id)!.lastActivityAt + 61_000;
    expect(await sessions.sweepIdle(60_000, idleAt)).toContain(conv.id);
  });
});

/** The registry row is the source of truth for existence, so ending a conversation must remove it. */
describe("end() removes the conversation from the registry", () => {
  it("removes the registry entry, not just local state", async () => {
    const remove = vi.fn(async () => {});
    const conversationRegistry = { ...noopRegistry, remove } as never;
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store: inMemoryStore(),
      conversationRegistry,
    });

    const conv = await sessions.start("thread-cr-remove" as never);
    await sessions.end(conv.id as SessionId);

    // Otherwise hydrate() re-adopts the conversation from its surviving row.
    expect(remove).toHaveBeenCalledWith(conv.id);
    expect(sessions.get(conv.id as SessionId), "and it is gone locally").toBeUndefined();
  });

  it("a registry failure does NOT fail the delete", async () => {
    // A k8s hiccup must not turn a successful local delete into a 500 for the caller.
    const remove = vi.fn(async () => {
      throw new Error("apiserver unreachable");
    });
    const conversationRegistry = { ...noopRegistry, remove } as never;
    const sessions = createSessionManager({
      provisioner: fakeProvisioner(),
      store: inMemoryStore(),
      conversationRegistry,
    });

    const conv = await sessions.start("thread-cr-remove-fail" as never);
    await expect(sessions.end(conv.id as SessionId)).resolves.not.toThrow();
  });
});
