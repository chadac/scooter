/**
 * GET /conversations/:id/events.integrity replays the full log, including events whose
 * fire-and-forget append is still in flight when the stream opens, so the route flushes
 * the store before replaying. A stream on a pod that does not own the conversation ends
 * after the replay so the client reconnects through the router to the owner.
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

/** A SessionManager stub with only the get()/ensureReadable() the route needs. */
function stubSessions(id: string): SessionManager {
  return {
    get: (x: string) => (x === id ? ({ id } as never) : undefined),
    ensureReadable: async (x: string) => x === id,
  } as unknown as SessionManager;
}

const stubServer = { broadcast: () => {} } as never;

/** Start the SSE integrity route synchronously so its replay races a pending append, capturing the written frames. */
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
  const matched = api.handle(req, res);
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
        answerInterrupt: async () => ({ ok: true }),
      });

      // The user's message is appended fire-and-forget, as wireEventLog does, so the write is still pending.
      void store.appendEvent(id, userMsg("hello from the revived conversation"));

      // Open the integrity stream in the same tick so its read races the pending append.
      const stream = startIntegrity(api, id);
      await new Promise((r) => setTimeout(r, 50));
      stream.close();
      const body = await stream.done;

      expect(body).toContain('"kind":"synced"');
      expect(body, "the just-appended message must be in the replay, not lost").toContain(
        "hello from the revived conversation",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("events.integrity — system messages", () => {
  it("stamps each replayed SYSTEM_MESSAGE with the snapshot message it followed", async () => {
    const root = mkdtempSync(join(tmpdir(), "integrity-route-"));
    try {
      const store = createFileConversationStore(root);
      const id = "conv-sys";
      const api = createManagementApi({ sessions: stubSessions(id), store, server: stubServer, answerInterrupt: async () => ({ ok: true }) });
      const events = [
        { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hi" },
        { type: "TEXT_MESSAGE_END", messageId: "u1" },
        { type: "SYSTEM_MESSAGE", messageId: "sys-1", source: "github", text: "PR #4 labeled" },
        { type: "TEXT_MESSAGE_START", messageId: "a1", role: "assistant" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "a1", delta: "on it" },
        { type: "TEXT_MESSAGE_END", messageId: "a1" },
      ] as unknown as AguiEvent[];
      for (const e of events) await store.appendEvent(id, e);

      const stream = startIntegrity(api, id);
      await new Promise((r) => setTimeout(r, 50));
      stream.close();
      const frames = (await stream.done)
        .split("\n\n").filter(Boolean)
        .map((f) => JSON.parse(f.replace(/^data: /, "")) as { event?: { type: string; afterMessageId?: unknown } });
      const sys = frames.find((f) => f.event?.type === "SYSTEM_MESSAGE");
      expect(sys?.event?.afterMessageId).toBe("u1");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("events.integrity — ownership", () => {
  /** Like startIntegrity, but also reports whether the handler ended the response. */
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
    // Live appends only reach the owner's local store, so a non-owner stream would sit silent after the replay.
    const root = mkdtempSync(join(tmpdir(), "integrity-owner-"));
    try {
      const store = createFileConversationStore(root);
      const id = "conv-owned-elsewhere";
      const api = createManagementApi({
        sessions: stubSessions(id),
        store,
        server: stubServer,
        answerInterrupt: async () => ({ ok: true }),
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
          answerInterrupt: async () => ({ ok: true }),
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

});
