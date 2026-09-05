/**
 * Two tabs (two concurrent events.integrity connections) on the SAME conversation, on the
 * SAME (owner) pod: both must receive a LIVE append after they're synced.
 *
 * This is the SERVER-SIDE half of the "two tabs, one goes silent" investigation. The
 * store's onAppend fan-out is a listener SET, so once both tabs' streams reach the owner
 * pod they BOTH get every live event (proven here). The silence was NOT here — it was the
 * controller leaving status.hostIP stale/empty while hostPod stayed ready, so the router
 * scattered the two tabs across pods and only the one that happened to hit the owner
 * streamed (fixed in conversation-controller reconcile: RepairHostIP). This test guards the
 * server contract so a future regression in the fan-out is caught directly.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createFileConversationStore } from "../../src/session/fileStore.js";
import { createManagementApi } from "../../src/api/management.js";
import type { SessionManager } from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";

const userMsg = (id: string, delta: string): AguiEvent => ({
  type: "TEXT_MESSAGE_CONTENT",
  messageId: id,
  delta,
});

function stubSessions(id: string): SessionManager {
  return {
    get: (x: string) => (x === id ? ({ id } as never) : undefined),
    ensureReadable: async (x: string) => x === id,
  } as unknown as SessionManager;
}

const stubServer = { onPermission: () => {}, broadcast: () => {} } as never;

function openTab(api: ReturnType<typeof createManagementApi>, id: string) {
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as { method?: string }).method = "GET";
  (req as { url?: string }).url = `/conversations/${id}/events.integrity`;
  (req as { headers?: Record<string, string> }).headers = {};
  let body = "";
  const res = {
    writeHead: () => res,
    write: (c: string) => {
      body += c;
      return true;
    },
    end: () => {},
    on: () => res,
    req,
  } as unknown as ServerResponse;
  void api.handle(req, res);
  return { body: () => body, close: () => (req as PassThrough).emit("close") };
}

describe("events.integrity — two concurrent tabs", () => {
  it("delivers a LIVE append to BOTH tabs", async () => {
    const root = mkdtempSync(join(tmpdir(), "integrity-two-"));
    try {
      const store = createFileConversationStore(root);
      const id = "conv-two";
      const api = createManagementApi({
        sessions: stubSessions(id),
        store,
        server: stubServer,
        answerPermission: async () => {},
      });

      // Seed one message so there's some history.
      await store.appendEvent(id, userMsg("u1", "first"));
      await store.flush?.(id);

      // Two tabs open concurrently.
      const tabA = openTab(api, id);
      const tabB = openTab(api, id);

      // Let both replay + go live (synced).
      await new Promise((r) => setTimeout(r, 80));
      expect(tabA.body(), "tab A synced").toContain('"kind":"synced"');
      expect(tabB.body(), "tab B synced").toContain('"kind":"synced"');

      // Now a LIVE append (as if the agent replied) AFTER both are live.
      await store.appendEvent(id, userMsg("a1", "live-reply-payload"));
      await store.flush?.(id);
      await new Promise((r) => setTimeout(r, 80));

      expect(tabA.body(), "tab A must receive the live append").toContain("live-reply-payload");
      expect(tabB.body(), "tab B must receive the live append").toContain("live-reply-payload");

      tabA.close();
      tabB.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
