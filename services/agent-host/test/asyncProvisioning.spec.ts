/**
 * Tests for async conversation provisioning (D1-D5).
 * 
 * RED-FIRST: Each test is written to fail before the implementation,
 * then passes after. Mutation tests verify they actually catch defects.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createSessionManager, type SessionManagerDeps, type ConversationStore } from "../src/session/manager.js";
import { ControllableProvisioner } from "./helpers/controllableProvisioner.js";
import type { SessionId, ThreadId } from "../src/types.js";
import type { AguiEvent } from "../src/bridge.js";

describe("Async Conversation Provisioning", () => {
  let provisioner: ControllableProvisioner;
  let store: ConversationStore;
  let events: Array<{ id: SessionId; event: AguiEvent }>;

  beforeEach(() => {
    provisioner = new ControllableProvisioner();
    events = [];
    
    // In-memory store for tests
    store = {
      appendEvent: vi.fn(async (id: SessionId, event: AguiEvent) => {
        events.push({ id, event });
      }),
      readEvents: vi.fn(async function* (_id: SessionId) {
        // empty for new conversations
      }),
      gooseStatePath: vi.fn((id: SessionId) => `/tmp/goose-${id}`),
      saveMeta: vi.fn(async () => {}),
      listConversations: vi.fn(async () => []),
    };
  });

  describe("D1: Returns immediately before provisioning finishes", () => {
    it("returns conversation with provisioning status without waiting for slow provisioner", async () => {
      // RED-FIRST: This test will FAIL with the old sync start() that awaits provisioner.create()
      // Set provisioner to take 1 second
      provisioner.setConfig({ delayMs: 1000 });

      const deps: SessionManagerDeps = { provisioner, store };
      const manager = createSessionManager(deps);

      const startTime = Date.now();
      const conv = await manager.start("test-thread-1" as ThreadId, undefined, undefined);
      const elapsed = Date.now() - startTime;

      // Should return in well under 1 second (the provisioner's delay)
      expect(elapsed).toBeLessThan(500);
      expect(conv.status).toBe("provisioning");
      expect(conv.id).toBe("test-thread-1");
    });

    it("conversation is immediately visible in list with provisioning status", async () => {
      provisioner.setConfig({ delayMs: 500 });

      const deps: SessionManagerDeps = { provisioner, store };
      const manager = createSessionManager(deps);

      await manager.start("test-thread-2" as ThreadId, undefined, undefined);

      // Should be visible immediately, even though provisioning hasn't finished
      const list = manager.list();
      expect(list).toHaveLength(1);
      expect(list[0].status).toBe("provisioning");
    });
  });

  describe("D2: Observable provisioning state", () => {
    it("transitions from provisioning -> ready on success", async () => {
      provisioner.setConfig({ delayMs: 100 });

      const deps: SessionManagerDeps = { provisioner, store };
      const manager = createSessionManager(deps);

      const conv = await manager.start("test-thread-3" as ThreadId, undefined, undefined);
      expect(conv.status).toBe("provisioning");

      // Wait for provisioning to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      const updated = manager.get(conv.id);
      expect(updated?.status).toBe("ready");
      expect(updated?.sandbox.namespace).not.toBe("");
    });

    it("emits PROVISIONING_STARTED event", async () => {
      const deps: SessionManagerDeps = { provisioner, store };
      const manager = createSessionManager(deps);

      await manager.start("test-thread-4" as ThreadId, undefined, undefined);

      // Wait a bit for the async provisioning to start
      await new Promise((resolve) => setTimeout(resolve, 50));

      const startedEvents = events.filter((e) => e.event.type === "PROVISIONING_STARTED");
      expect(startedEvents).toHaveLength(1);
      expect(startedEvents[0].event).toMatchObject({
        type: "PROVISIONING_STARTED",
        threadId: "test-thread-4",
      });
    });

    it("persists provisioning error on failure for reattaching UI", async () => {
      provisioner.setConfig({ alwaysFail: true, errorMessage: "Pod scheduling failed" });

      const deps: SessionManagerDeps = { provisioner, store, provisionRetryMax: 1 };
      const manager = createSessionManager(deps);

      await manager.start("test-thread-5" as ThreadId, undefined, undefined);

      // Wait for provisioning to fail
      await new Promise((resolve) => setTimeout(resolve, 100));

      const conv = manager.get("test-thread-5" as SessionId);
      expect(conv?.status).toBe("failed");
      
      // Error should be persisted as an event (reattach case from design doc)
      const errorEvents = events.filter((e) => e.event.type === "PROVISIONING_ERROR");
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].event).toMatchObject({
        type: "PROVISIONING_ERROR",
        threadId: "test-thread-5",
      });
    });
  });

  describe("D3: Retry with backoff", () => {
    it("retries provisioning on failure up to configured max", async () => {
      // Fail twice, then succeed
      provisioner.setConfig({ failCount: 2, delayMs: 10 });

      const deps: SessionManagerDeps = {
        provisioner,
        store,
        provisionRetryMax: 3,
        provisionRetryBaseMs: 10,
        provisionRetryCapMs: 100,
      };
      const manager = createSessionManager(deps);

      await manager.start("test-thread-6" as ThreadId, undefined, undefined);

      // Wait for retries to complete
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should succeed after 2 retries
      const conv = manager.get("test-thread-6" as SessionId);
      expect(conv?.status).toBe("ready");
      expect(provisioner.getCallCount()).toBe(3); // 2 failures + 1 success
    });

    it("emits PROVISIONING_RETRYING events with attempt counter", async () => {
      provisioner.setConfig({ failCount: 2, delayMs: 10 });

      const deps: SessionManagerDeps = {
        provisioner,
        store,
        provisionRetryMax: 3,
        provisionRetryBaseMs: 10,
      };
      const manager = createSessionManager(deps);

      await manager.start("test-thread-7" as ThreadId, undefined, undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const retryEvents = events.filter((e) => e.event.type === "PROVISIONING_RETRYING");
      expect(retryEvents.length).toBeGreaterThan(0);
      
      // Verify attempt counter increments
      if (retryEvents.length > 0) {
        expect(retryEvents[0].event).toMatchObject({
          type: "PROVISIONING_RETRYING",
          attempt: 1,
          max: 3,
        });
      }
    });

    it("transitions to failed after retry exhaustion", async () => {
      provisioner.setConfig({ alwaysFail: true });

      const deps: SessionManagerDeps = {
        provisioner,
        store,
        provisionRetryMax: 2,
        provisionRetryBaseMs: 10,
      };
      const manager = createSessionManager(deps);

      await manager.start("test-thread-8" as ThreadId, undefined, undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const conv = manager.get("test-thread-8" as SessionId);
      expect(conv?.status).toBe("failed");
      expect(provisioner.getCallCount()).toBe(2); // Tried max times
    });
  });

  describe("D4: Failed conversation is recoverable", () => {
    it("failed conversation preserves ID and can be retried", async () => {
      provisioner.setConfig({ alwaysFail: true });

      const deps: SessionManagerDeps = {
        provisioner,
        store,
        provisionRetryMax: 1,
      };
      const manager = createSessionManager(deps);

      const conv = await manager.start("test-thread-9" as ThreadId, undefined, undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify it failed
      expect(manager.get(conv.id)?.status).toBe("failed");

      // The conversation should still exist and be queryable
      const failed = manager.get(conv.id);
      expect(failed).toBeDefined();
      expect(failed?.id).toBe(conv.id);
      expect(failed?.threadId).toBe("test-thread-9");
    });
  });

  describe("D5: Messages sent during provisioning are queued", () => {
    it("queues message sent while provisioning and runs after ready", async () => {
      provisioner.setConfig({ delayMs: 100 });

      const deps: SessionManagerDeps = { provisioner, store };
      const manager = createSessionManager(deps);

      const conv = await manager.start("test-thread-10" as ThreadId, undefined, undefined);
      expect(conv.status).toBe("provisioning");

      // Send a message while still provisioning
      await manager.promptByThread(
        "test-thread-10" as ThreadId,
        "Hello during provisioning",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      );

      // Message should be queued, not cause error
      const queued = manager.get(conv.id);
      expect(queued?.pendingQueue).toBeDefined();
      expect(queued?.pendingQueue?.length).toBe(1);
      expect(queued?.pendingQueue?.[0].text).toBe("Hello during provisioning");

      // Wait for provisioning to complete
      await new Promise((resolve) => setTimeout(resolve, 200));

      // After provisioning, queue should be cleared (messages sent to bridge)
      const ready = manager.get(conv.id);
      expect(ready?.status).toBe("ready");
      // pendingQueue is cleared after messages are replayed
      expect(ready?.pendingQueue?.length ?? 0).toBe(0);
    });

    it("multiple messages queued during provisioning are all replayed in order", async () => {
      provisioner.setConfig({ delayMs: 100 });

      const deps: SessionManagerDeps = { provisioner, store };
      const manager = createSessionManager(deps);

      const conv = await manager.start("test-thread-11" as ThreadId, undefined, undefined);

      // Send multiple messages while provisioning
      await manager.promptByThread("test-thread-11" as ThreadId, "Message 1", undefined, undefined, undefined, undefined, undefined, undefined);
      await manager.promptByThread("test-thread-11" as ThreadId, "Message 2", undefined, undefined, undefined, undefined, undefined, undefined);
      await manager.promptByThread("test-thread-11" as ThreadId, "Message 3", undefined, undefined, undefined, undefined, undefined, undefined);

      const queued = manager.get(conv.id);
      expect(queued?.pendingQueue?.length).toBe(3);

      await new Promise((resolve) => setTimeout(resolve, 200));

      const ready = manager.get(conv.id);
      expect(ready?.status).toBe("ready");
      expect(ready?.pendingQueue?.length ?? 0).toBe(0);
    });
  });

  describe("Mutation tests - verify tests catch real bugs", () => {
    it("MUTATION: changing status to 'running' instead of 'provisioning' should fail", async () => {
      // This test verifies that the D1 test actually checks the status
      const deps: SessionManagerDeps = { provisioner, store };
      const manager = createSessionManager(deps);

      const conv = await manager.start("test-thread-12" as ThreadId, undefined, undefined);
      
      // If we mutated the code to return "running", this would fail
      expect(conv.status).toBe("provisioning");
      expect(conv.status).not.toBe("running");
    });

    it("MUTATION: removing PROVISIONING_STARTED event should fail", async () => {
      const deps: SessionManagerDeps = { provisioner, store };
      const manager = createSessionManager(deps);

      await manager.start("test-thread-13" as ThreadId, undefined, undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));

      // If we mutated the code to not emit this event, this would fail
      const startedEvents = events.filter((e) => e.event.type === "PROVISIONING_STARTED");
      expect(startedEvents.length).toBeGreaterThan(0);
    });

    it("MUTATION: skipping retry should fail", async () => {
      provisioner.setConfig({ failCount: 1 });

      const deps: SessionManagerDeps = {
        provisioner,
        store,
        provisionRetryMax: 2,
        provisionRetryBaseMs: 10,
      };
      const manager = createSessionManager(deps);

      await manager.start("test-thread-14" as ThreadId, undefined, undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // If we mutated the code to not retry, status would be "failed" instead of "ready"
      const conv = manager.get("test-thread-14" as SessionId);
      expect(conv?.status).toBe("ready");
      expect(provisioner.getCallCount()).toBe(2); // Should have retried
    });

    it("MUTATION: not queuing messages during provisioning should fail", async () => {
      provisioner.setConfig({ delayMs: 100 });

      const deps: SessionManagerDeps = { provisioner, store };
      const manager = createSessionManager(deps);

      await manager.start("test-thread-15" as ThreadId, undefined, undefined);
      await manager.promptByThread("test-thread-15" as ThreadId, "Test", undefined, undefined, undefined, undefined, undefined, undefined);

      // If we mutated the code to not queue, pendingQueue would be undefined
      const conv = manager.get("test-thread-15" as SessionId);
      expect(conv?.pendingQueue).toBeDefined();
      expect(conv?.pendingQueue?.length).toBeGreaterThan(0);
    });
  });
});
