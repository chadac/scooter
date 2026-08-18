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
