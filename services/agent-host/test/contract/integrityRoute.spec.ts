/**
 * Tier 1 contract — GET /conversations/:id/events.integrity replays the FULL log,
 * including events whose fire-and-forget append is still in flight when the stream opens.
 *
 * The bug (first-hit on a suspended conversation): the user sends a message to a suspended
 * conversation, revive() rebuilds the bridge, the message is emitted + persisted via a
 * FIRE-AND-FORGET store.appendEvent(). Meanwhile the UI opens events.integrity, which reads
 * the persisted log with readEventsWithChecksum WITHOUT first flushing pending appends — so
 * the read races the write and misses the just-sent message. It "disappears" until a refresh
 * (by then the append has landed). The route must `await store.flush(id)` before replaying.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { mirroredConversationStore } from "../../src/session/mirroredStore.js";
import { createFileConversationStore } from "../../src/session/fileStore.js";
import { createManagementApi } from "../../src/api/management.js";
import type { SessionManager } from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";

const userMsg = (delta: string): AguiEvent => ({
  type: "TEXT_MESSAGE_CONTENT",
  messageId: "u1",
  delta,
});

/** Minimal SessionManager stub: the integrity route only needs get()/ensureReadable(). */
function stubSessions(id: string): SessionManager {
  return {
    get: (x: string) => (x === id ? ({ id } as never) : undefined),
    ensureReadable: async (x: string) => x === id,
  } as unknown as SessionManager;
}

const stubServer = { onPermission: () => {}, broadcast: () => {} } as never;

/** Start the SSE integrity route SYNCHRONOUSLY (no awaits before handle, so the replay's
 *  file read races any still-pending fire-and-forget append), capture res.write frames, and
 *  return a controller to close it once replay is done. */
function startIntegrity(
  api: ReturnType<typeof createManagementApi>,
  id: string,
): { done: Promise<string>; body: () => string; close: () => void } {
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
  const matched = api.handle(req, res); // NO await — start synchronously to race the append
  return {
    done: matched.then(() => body),
    body: () => body,
    close: () => (req as PassThrough).emit("close"),
  };
}

describe("events.integrity — replays an in-flight (unflushed) append", () => {
  it("includes a fire-and-forget appended message in the initial replay (no lost message)", async () => {
    const root = mkdtempSync(join(tmpdir(), "integrity-route-"));
    try {
      const store = createFileConversationStore(root);
      const id = "conv-1";
      const api = createManagementApi({
        sessions: stubSessions(id),
        store,
        server: stubServer,
        answerPermission: async () => {},
      });

      // Simulate the revive path: the user's message is appended FIRE-AND-FORGET (not awaited),
      // exactly as wireEventLog does (void store.appendEvent(...)). The write takes several
      // awaits (ensureDir → seedChecksum → appendFile → onAppend), so it is STILL PENDING now.
      void store.appendEvent(id, userMsg("hello from the revived conversation"));

      // Open the integrity stream in the SAME tick — its readEventsWithChecksum races the
      // pending appendFile. Without an `await store.flush(id)` before the replay, the file read
      // completes first (empty), onAppend hasn't fired yet, and the message is in NEITHER the
      // replay NOR the live buffer → lost until the user refreshes. The flush fix closes this.
      const stream = startIntegrity(api, id);
      // Let the handler run to `synced` (replay done) + the append settle, then close.
      await new Promise((r) => setTimeout(r, 50));
      stream.close();
      const body = await stream.done;

      expect(body).toContain('"kind":"synced"'); // stream replayed cleanly
      expect(body, "the just-appended message must be in the replay, not lost").toContain(
        "hello from the revived conversation",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("events.integrity — ownership", () => {
  /** Like startIntegrity, but also reports whether the handler ENDED the response. */
  function startWithEnd(api: ReturnType<typeof createManagementApi>, id: string) {
    const req = new PassThrough() as unknown as IncomingMessage;
    (req as { method?: string }).method = "GET";
    (req as { url?: string }).url = `/conversations/${id}/events.integrity`;
    (req as { headers?: Record<string, string> }).headers = {};
    let body = "";
    let ended = false;
    const res = {
      writeHead: () => res,
      write: (c: string) => {
        body += c;
        return true;
      },
      end: () => {
        ended = true;
      },
      on: () => res,
      req,
    } as unknown as ServerResponse;
    void api.handle(req, res);
    return { body: () => body, ended: () => ended, close: () => (req as PassThrough).emit("close") };
  }

  it("ENDS the stream after replay when another pod owns the conversation", async () => {
    // THE TIER-2 COIN FLIP. A stream opened before the controller assigned an owner
    // lands on a random pod; live appends only reach the OWNER's local store, so on the
    // non-owner the stream replayed history and then sat silent FOREVER — no tool card,
    // no reply, "Working…" until the user refreshed. Verified by a three-way capture on
    // k3d: router + owner streams complete, the non-owner stream utterly empty. Ending
    // the stream hands the client's reconnect back to the router, which routes by
    // hostIP once assignment exists.
    const root = mkdtempSync(join(tmpdir(), "integrity-owner-"));
    try {
      const store = createFileConversationStore(root);
      const id = "conv-owned-elsewhere";
      const api = createManagementApi({
        sessions: stubSessions(id),
        store,
        server: stubServer,
        answerPermission: async () => {},
        streamOwnership: async () => "elsewhere",
      });
      const stream = startWithEnd(api, id);
      await new Promise((r) => setTimeout(r, 80));
      expect(stream.body(), "the replay + synced still serve (history is readable anywhere)").toContain('"synced"');
      expect(stream.ended(), "a non-owner stream must END so the client reconnects to the owner").toBe(true);
      stream.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stays OPEN when this pod owns it (and when ownership is unknown)", async () => {
    const root = mkdtempSync(join(tmpdir(), "integrity-owner2-"));
    try {
      const store = createFileConversationStore(root);
      for (const where of ["mine", "unknown"] as const) {
        const id = `conv-${where}`;
        const api = createManagementApi({
          sessions: stubSessions(id),
          store,
          server: stubServer,
          answerPermission: async () => {},
          streamOwnership: async () => where,
        });
        const stream = startWithEnd(api, id);
        await new Promise((r) => setTimeout(r, 80));
        expect(stream.ended(), `a "${where}" stream must stay open`).toBe(false);
        stream.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("THE REGRESSION: replays the MIRROR's log when local is empty (post-rollout)", async () => {
    // LOCAL_STATE_PATH is an emptyDir, so a restart leaves the local log empty while the
    // mirror keeps the history. Replaying from local streamed `synced` and nothing else —
    // the UI rendered an empty conversation whose events were intact all along.
    const localRoot = mkdtempSync(join(tmpdir(), "integrity-local-"));
    const mirrorRoot = mkdtempSync(join(tmpdir(), "integrity-mirror-"));
    try {
      const id = "conv-rollout";
      const mirror = createFileConversationStore(mirrorRoot);
      await mirror.appendEvent(id, userMsg("from-the-mirror"));
      // Local is a DIFFERENT, empty root — exactly the post-restart shape.
      const store = mirroredConversationStore(createFileConversationStore(localRoot), mirror);
      const api = createManagementApi({
        sessions: stubSessions(id),
        store,
        server: stubServer,
        answerPermission: async () => {},
      });
      const stream = startIntegrity(api, id);
      await new Promise((r) => setTimeout(r, 120));
      stream.close();
      expect(stream.body()).toContain("from-the-mirror");
      expect(stream.body()).toContain('"kind":"synced"');
    } finally {
      rmSync(localRoot, { recursive: true, force: true });
      rmSync(mirrorRoot, { recursive: true, force: true });
    }
  });

  it("ensureReadable still pulls the mirror for a conversation already IN MEMORY", async () => {
    // hydrate() loads META from the mirror at startup, so every conversation is an entry
    // while its events were never pulled. Returning true on the entry alone skipped the
    // pull for exactly the conversations that needed it.
    const root = mkdtempSync(join(tmpdir(), "integrity-known-"));
    try {
      const id = "conv-known";
      let pulls = 0;
      const sessions = {
        // In memory (hydrated) — but its events are NOT local.
        get: () => undefined,
        ensureReadable: async () => {
          pulls++;
          return true;
        },
      } as unknown as SessionManager;
      const api = createManagementApi({
        sessions,
        store: createFileConversationStore(root),
        server: stubServer,
        answerPermission: async () => {},
      });
      const stream = startIntegrity(api, id);
      await new Promise((r) => setTimeout(r, 80));
      stream.close();
      expect(pulls).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
