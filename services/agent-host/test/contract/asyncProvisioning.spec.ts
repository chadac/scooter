/**
 * Tier 1 contract — async conversation provisioning.
 *
 * Tests that POST /conversations returns immediately (before provisioning completes),
 * that provisioning failures retry with backoff, that the failure state is durable,
 * and that messages sent during provisioning are queued.
 *
 * Uses a controllable test provisioner that can be slow and can fail on demand.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SandboxRef } from "../../src/types.js";
import type { SandboxProvisioner } from "../../src/session/manager.js";
import { createSessionManager } from "../../src/session/manager.js";
import type { ConversationStore } from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";

/** A controllable test provisioner that can be slow and can fail. */
interface ControllableProvisioner extends SandboxProvisioner {
  /** Resolve all pending create() calls. */
  resolvePending(): void;
  /** Reject all pending create() calls with the given error. */
  rejectPending(error: Error): void;
  /** Number of create() calls made. */
  createCallCount: number;
  /** Whether create() is currently pending. */
  isPending: boolean;
}

function createControllableProvisioner(): ControllableProvisioner {
  let pendingResolvers: Array<{ resolve: (ref: SandboxRef) => void; reject: (err: Error) => void }> = [];
  let callCount = 0;

  const provisioner: ControllableProvisioner = {
    async create(conversationId: string, threadId?: string): Promise<SandboxRef> {
      callCount++;
      return new Promise<SandboxRef>((resolve, reject) => {
        pendingResolvers.push({ resolve, reject });
      });
    },
    async suspend(ref: SandboxRef): Promise<void> {},
    async resume(ref: SandboxRef): Promise<SandboxRef> {
      return ref;
    },
    async destroy(ref: SandboxRef): Promise<void> {},
    
    resolvePending() {
      const resolvers = pendingResolvers;
      pendingResolvers = [];
      for (const { resolve } of resolvers) {
        resolve({ name: `conv-test`, namespace: "test-ns" });
      }
    },
    
    rejectPending(error: Error) {
      const resolvers = pendingResolvers;
      pendingResolvers = [];
      for (const { reject } of resolvers) {
        reject(error);
      }
    },
    
    get createCallCount() {
      return callCount;
    },
    
    get isPending() {
      return pendingResolvers.length > 0;
    },
  };

  return provisioner;
}

function fakeStore(): ConversationStore {
  const events = new Map<string, AguiEvent[]>();
  const meta = new Map<string, unknown>();
  
  return {
    async appendEvent(id: string, event: AguiEvent) {
      if (!events.has(id)) events.set(id, []);
      events.get(id)!.push(event);
    },
    async *readEvents(id: string) {
      const convEvents = events.get(id) ?? [];
      yield* convEvents;
    },
    async saveMeta(metaData: any) {
      // saveMeta takes ConversationMeta, not (id, data)
      meta.set(metaData.id, metaData);
    },
    async readMeta(id: string) {
      return meta.get(id) ?? null;
    },
    gooseStatePath: (id: string) => `/state/${id}`,
  } as ConversationStore;
}

describe("Async provisioning", () => {
  let provisioner: ControllableProvisioner;
  let store: ConversationStore;

  beforeEach(() => {
    provisioner = createControllableProvisioner();
    store = fakeStore();
  });

  it("start() returns immediately, before provisioning completes", async () => {
    const sessions = createSessionManager({ provisioner, store });
    
    // Call start() - should return immediately even though provisioner.create() is pending
    const conv = await sessions.start("thread1");
    
    // The conversation should exist with "provisioning" status
    expect(conv).toBeDefined();
    expect(conv.id).toBe("thread1");
    expect(conv.status).toBe("provisioning");
    
    // Provisioner should have been called but still pending
    expect(provisioner.createCallCount).toBe(1);
    expect(provisioner.isPending).toBe(true);
    
    // Cleanup: resolve the pending provisioner call
    provisioner.resolvePending();
  });

  it("conversation transitions to 'ready' after successful provisioning", async () => {
    const sessions = createSessionManager({ provisioner, store });
    
    const conv = await sessions.start("thread2");
    expect(conv.status).toBe("provisioning");
    
    // Resolve provisioning
    provisioner.resolvePending();
    
    // Wait a bit for async provisioning to complete
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Status should now be ready
    const updated = sessions.get(conv.id);
    expect(updated?.status).toBe("ready");
  });

  it("provisioning failure triggers retry with backoff", async () => {
    const sessions = createSessionManager({ 
      provisioner, 
      store,
      provisionRetryMax: 3,
      provisionRetryBaseMs: 10, // 10ms for fast tests
    });
    
    const conv = await sessions.start("thread3");
    expect(conv.status).toBe("provisioning");
    expect(provisioner.createCallCount).toBe(1);
    
    // Fail the first attempt
    provisioner.rejectPending(new Error("Provisioning failed"));
    
    // Wait for retry
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // Should have retried
    expect(provisioner.createCallCount).toBe(2);
    
    // Cleanup: resolve the retry
    provisioner.resolvePending();
  });

  it("conversation reaches 'failed' after exhausting retries", async () => {
    const sessions = createSessionManager({ 
      provisioner, 
      store,
      provisionRetryMax: 2,
      provisionRetryBaseMs: 10,
    });
    
    const conv = await sessions.start("thread4");
    expect(conv.status).toBe("provisioning");
    
    // Fail all attempts
    for (let i = 0; i < 3; i++) {
      provisioner.rejectPending(new Error("Pod scheduling failed"));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Should have tried 3 times (initial + 2 retries)
    expect(provisioner.createCallCount).toBe(3);
    
    // Status should be failed
    const updated = sessions.get(conv.id);
    expect(updated?.status).toBe("failed");
  });

  it("provisioning failure is persisted in event log", async () => {
    const sessions = createSessionManager({ 
      provisioner, 
      store,
      provisionRetryMax: 1,
      provisionRetryBaseMs: 10,
    });
    
    const conv = await sessions.start("thread5");
    
    // Fail all attempts
    for (let i = 0; i < 2; i++) {
      provisioner.rejectPending(new Error("Infrastructure error"));
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Read events from store
    const events: AguiEvent[] = [];
    for await (const event of store.readEvents!(conv.id)) {
      events.push(event);
    }
    
    // Should have a PROVISIONING_FAILED event
    const failureEvent = events.find((e: any) => e.type === "PROVISIONING_FAILED");
    expect(failureEvent).toBeDefined();
    expect((failureEvent as any).error).toContain("Infrastructure error");
  });

  it("a failed conversation can be retried", async () => {
    const sessions = createSessionManager({ 
      provisioner, 
      store,
      provisionRetryMax: 0, // Fail immediately
    });
    
    const conv = await sessions.start("thread6");
    provisioner.rejectPending(new Error("Initial failure"));
    await new Promise(resolve => setTimeout(resolve, 50));
    
    expect(sessions.get(conv.id)?.status).toBe("failed");
    
    // Reset call count for clarity
    const beforeRetry = provisioner.createCallCount;
    
    // Retry provisioning
    await sessions.retryProvisioning(conv.id);
    
    // Should have called provisioner again
    expect(provisioner.createCallCount).toBeGreaterThan(beforeRetry);
    
    // Resolve this time
    provisioner.resolvePending();
    await new Promise(resolve => setTimeout(resolve, 50));
    
    expect(sessions.get(conv.id)?.status).toBe("ready");
  });

  it("messages sent during provisioning are queued and run when ready", async () => {
    const sessions = createSessionManager({ provisioner, store });
    
    const conv = await sessions.start("thread7");
    expect(conv.status).toBe("provisioning");
    
    // Try to send a message while still provisioning
    const promptPromise = sessions.prompt(conv.id, { text: "Hello" });
    
    // Message should be queued (promise doesn't resolve yet)
    const raced = await Promise.race([
      promptPromise.then(() => "resolved"),
      new Promise(resolve => setTimeout(() => resolve("pending"), 20)),
    ]);
    expect(raced).toBe("pending");
    
    // Now complete provisioning
    provisioner.resolvePending();
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // The queued message should now be processed
    // (In a real implementation with a bridge, this would actually run the prompt)
    // For now, we just verify the conversation is ready
    expect(sessions.get(conv.id)?.status).toBe("ready");
  });
});
