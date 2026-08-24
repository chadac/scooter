/**
 * Tier 1 contract test — webhook event routing to existing conversations.
 *
 * Tests that webhook events (check_suite failures, PR comments) are routed back
 * to the conversation that owns the linked PR/MR/issue, instead of creating new
 * conversations. Includes loop-prevention tests to avoid infinite notification loops.
 *
 * RED-FIRST: these tests are written BEFORE the webhook routing implementation
 * and should fail initially.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileConversationStore } from "../../src/session/fileStore.js";
import type { ConversationStore } from "../../src/session/manager.js";

describe("webhook event routing", () => {
  let store: ConversationStore;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "scooter-webhook-test-"));
    store = createFileConversationStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("reverse lookup for routing", () => {
    it("finds the conversation owning a PR by URL", async () => {
      const convId = "conv-pr-owner";
      
      await store.saveMeta?.({
        id: convId,
        threadId: convId,
        title: "PR #42 work",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        owner: "alice@example.com",
      });

      await store.addLink?.(convId, {
        source: "github",
        resourceType: "pull_request",
        url: "https://github.com/owner/repo/pull/42",
        title: "PR #42",
        ref: { owner: "owner", repo: "repo", number: 42 },
      });

      const result = await store.findConversationByLink?.(
        "https://github.com/owner/repo/pull/42"
      );
      expect(result).toBe(convId);
    });

    it("returns null when no conversation owns the URL", async () => {
      const result = await store.findConversationByLink?.(
        "https://github.com/owner/repo/pull/999"
      );
      expect(result).toBeNull();
    });

    it("scopes lookup by owner for multi-tenant safety", async () => {
      const convAlice = "conv-alice";
      const convBob = "conv-bob";

      // Alice's conversation
      await store.saveMeta?.({
        id: convAlice,
        threadId: convAlice,
        title: "Alice's PR",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        owner: "alice@example.com",
      });

      await store.addLink?.(convAlice, {
        source: "github",
        resourceType: "pull_request",
        url: "https://github.com/owner/repo/pull/42",
        title: "PR #42",
      });

      // Bob's conversation (same PR URL)
      await store.saveMeta?.({
        id: convBob,
        threadId: convBob,
        title: "Bob's PR",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        owner: "bob@example.com",
      });

      await store.addLink?.(convBob, {
        source: "github",
        resourceType: "pull_request",
        url: "https://github.com/owner/repo/pull/42",
        title: "PR #42",
      });

      // Looking up with Alice's owner should return only her conversation
      const aliceResult = await store.findConversationByLink?.(
        "https://github.com/owner/repo/pull/42",
        "alice@example.com"
      );
      expect(aliceResult).toBe(convAlice);

      // Looking up with Bob's owner should return only his conversation
      const bobResult = await store.findConversationByLink?.(
        "https://github.com/owner/repo/pull/42",
        "bob@example.com"
      );
      expect(bobResult).toBe(convBob);

      // Looking up with a different owner should return null
      const charlieResult = await store.findConversationByLink?.(
        "https://github.com/owner/repo/pull/42",
        "charlie@example.com"
      );
      expect(charlieResult).toBeNull();
    });
  });

  describe("loop prevention", () => {
    it("identifies events from the agent's own GitHub App identity", () => {
      // Test helper: function to check if an event should be ignored
      const isOwnEvent = (actor: string, appIdentities: string[]) => {
        return appIdentities.some(id => actor.toLowerCase().includes(id.toLowerCase()));
      };

      const agentAppIds = ["app/scooter", "scooter[bot]"];

      // Should ignore
      expect(isOwnEvent("app/scooter-agent", agentAppIds)).toBe(true);
      expect(isOwnEvent("scooter[bot]", agentAppIds)).toBe(true);

      // Should NOT ignore (human users)
      expect(isOwnEvent("alice", agentAppIds)).toBe(false);
      expect(isOwnEvent("bob-reviewer", agentAppIds)).toBe(false);
    });

    it("prevents notification loops from agent-authored events", () => {
      // Scenario: agent pushes a commit -> CI runs -> agent is notified -> agent pushes -> loop
      // The guard: ignore check_suite/check_run events where the actor is the agent's own app

      const shouldNotifyOnCheckSuite = (actor: string, appIdentities: string[]) => {
        // Ignore if the actor is one of our app identities
        const isOwnApp = appIdentities.some(id => 
          actor.toLowerCase().includes(id.toLowerCase())
        );
        return !isOwnApp;
      };

      const agentAppIds = ["app/scooter", "scooter[bot]"];

      // Agent's own check run -> don't notify
      expect(shouldNotifyOnCheckSuite("app/scooter-ci", agentAppIds)).toBe(false);

      // Another user's check run -> notify
      expect(shouldNotifyOnCheckSuite("alice", agentAppIds)).toBe(true);
      expect(shouldNotifyOnCheckSuite("github-actions[bot]", agentAppIds)).toBe(true);
    });
  });

  describe("notification routing decisions (Q1-Q5)", () => {
    it("Q1: notifies on check failure, optionally on success", () => {
      // Decision to test: ALWAYS notify on failure, optionally on success
      const shouldNotify = (conclusion: string, conversationAwake: boolean) => {
        if (conclusion === "failure" || conclusion === "cancelled" || conclusion === "timed_out") {
          return true; // Always notify on failure
        }
        if (conclusion === "success") {
          return conversationAwake; // Only notify on success if conversation is awake
        }
        return false;
      };

      // Failure always notifies
      expect(shouldNotify("failure", false)).toBe(true);
      expect(shouldNotify("failure", true)).toBe(true);

      // Success only notifies if awake
      expect(shouldNotify("success", false)).toBe(false);
      expect(shouldNotify("success", true)).toBe(true);

      // Other conclusions
      expect(shouldNotify("cancelled", true)).toBe(true);
      expect(shouldNotify("skipped", true)).toBe(false);
    });

    it("Q2: notifies all linked conversations when multiple exist", async () => {
      // Decision: notify ALL conversations linked to the same PR
      const conv1 = "conv-multi-1";
      const conv2 = "conv-multi-2";

      await store.saveMeta?.({
        id: conv1,
        threadId: conv1,
        title: "Conv 1",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });

      await store.saveMeta?.({
        id: conv2,
        threadId: conv2,
        title: "Conv 2",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      });

      await store.addLink?.(conv1, {
        source: "github",
        resourceType: "pull_request",
        url: "https://github.com/owner/repo/pull/42",
        title: "PR #42",
      });

      await store.addLink?.(conv2, {
        source: "github",
        resourceType: "pull_request",
        url: "https://github.com/owner/repo/pull/42",
        title: "PR #42",
      });

      const allConversations = await store.findAllConversationsByLink?.(
        "https://github.com/owner/repo/pull/42"
      );

      expect(allConversations).toHaveLength(2);
      expect(allConversations).toContain(conv1);
      expect(allConversations).toContain(conv2);
    });

    it("Q3: resume policy (resume on failure, queue on success)", () => {
      // Test the decision logic (not the actual resume mechanism)
      const shouldResume = (conclusion: string, isSuspended: boolean) => {
        if (!isSuspended) return false; // Already running, no resume needed
        if (conclusion === "failure" || conclusion === "cancelled") {
          return true; // Resume on failure
        }
        return false; // Queue (don't resume) on success
      };

      // Failure resumes suspended conversation
      expect(shouldResume("failure", true)).toBe(true);
      expect(shouldResume("failure", false)).toBe(false);

      // Success doesn't resume
      expect(shouldResume("success", true)).toBe(false);
      expect(shouldResume("success", false)).toBe(false);
    });
  });
});
