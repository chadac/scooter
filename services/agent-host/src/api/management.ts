/**
 * Management API — REST surface for managing conversations.
 *
 * Wraps the SessionManager with conversation CRUD + lifecycle + history. The
 * AG-UI streaming endpoint (POST /agui) stays the assistant-ui transport; this
 * adds the management routes around it on the same node:http server.
 *
 *   GET    /conversations                  list
 *   POST   /conversations                  create {threadId?, title?}
 *   GET    /conversations/:id              get + status
 *   DELETE /conversations/:id              end (destroy sandbox)
 *   POST   /conversations/:id/suspend
 *   POST   /conversations/:id/resume
 *   POST   /conversations/:id/messages     prompt {text}
 *   GET    /conversations/:id/events       SSE stream
 *   GET    /conversations/:id/history      the event log
 *   POST   /conversations/:id/permission/:toolCallId  {optionId}
 */

import { randomUUID } from "node:crypto";

import { createRouter, type Router } from "../http/router.js";
import type { SessionManager, Conversation } from "../session/manager.js";
import type { ConversationStore, ChecksummedEvent } from "../session/manager.js";
import type { AguiServer } from "../agui/server.js";
import type { AguiEvent } from "../bridge.js";
import { EMPTY_CHECKSUM, chainAll } from "../agui/integrity.js";

/** Public (JSON-safe) view of a conversation — omits the in-memory bridge.
 *  Exposes activity metadata (lastActivityAt, idleMs, ageMs) so the UI and any
 *  external lifecycle manager can reason about idleness. */
function view(c: Conversation, now = Date.now()) {
  return {
    id: c.id,
    threadId: c.threadId,
    status: c.status,
    title: c.title,
    createdAt: c.createdAt,
    lastActivityAt: c.lastActivityAt,
    idleMs: Math.max(0, now - c.lastActivityAt),
    ageMs: Math.max(0, now - c.createdAt),
    model: c.model,
    sandbox: { name: c.sandbox.name, namespace: c.sandbox.namespace },
  };
}

export interface ManagementDeps {
  sessions: SessionManager;
  store: ConversationStore;
  server: AguiServer;
  /** Answer a pending tool permission (wired to the bridge in index.ts). */
  answerPermission: (sessionId: string, toolCallId: string, optionId: string) => Promise<void>;
  /** Model catalog for per-conversation selection: the host default + the set
   *  offered to clients. Empty list = only the default is selectable. */
  models?: { default?: string; available: string[] };
}

export function createManagementApi(deps: ManagementDeps): Router {
  const { sessions, store, server } = deps;
  const models = deps.models ?? { available: [] };
  const r = createRouter();

  // The model catalog — a UI populates its selector from this.
  r.get("/models", () => ({
    json: { default: models.default ?? null, available: models.available },
  }));

  r.get("/conversations", () => ({ json: sessions.list().map(view) }));

  r.post("/conversations", async (ctx) => {
    const body = await ctx.body<{ threadId?: string; title?: string; model?: string }>();
    const threadId = body.threadId ?? randomUUID();
    // Reject an unknown model rather than silently falling back, so a client
    // mistake is visible.
    if (body.model && body.model !== models.default && !models.available.includes(body.model)) {
      return { status: 400, json: { error: `unknown model: ${body.model}` } };
    }
    const conv = await sessions.start(threadId, body.model);
    if (body.title) sessions.setTitle(conv.id, body.title);
    return { status: 201, json: view(sessions.get(conv.id)!) };
  });

  r.get("/conversations/:id", (ctx) => {
    const conv = sessions.get(ctx.params.id);
    return conv ? { json: view(conv) } : { status: 404, json: { error: "not found" } };
  });

  r.del("/conversations/:id", async (ctx) => {
    if (!sessions.get(ctx.params.id)) return { status: 404, json: { error: "not found" } };
    await sessions.end(ctx.params.id);
    return { status: 204, json: null };
  });

  r.post("/conversations/:id/suspend", async (ctx) => {
    if (!sessions.get(ctx.params.id)) return { status: 404, json: { error: "not found" } };
    await sessions.suspend(ctx.params.id);
    return { json: view(sessions.get(ctx.params.id)!) };
  });

  r.post("/conversations/:id/resume", async (ctx) => {
    if (!sessions.get(ctx.params.id)) return { status: 404, json: { error: "not found" } };
    await sessions.revive(ctx.params.id);
    return { json: view(sessions.get(ctx.params.id)!) };
  });

  r.post("/conversations/:id/messages", async (ctx) => {
    const body = await ctx.body<{ text?: string }>();
    if (!body.text) return { status: 400, json: { error: "text required" } };
    // find-or-start by thread id, then prompt
    await sessions.promptByThread(ctx.params.id, body.text);
    return { status: 202, json: { ok: true } };
  });

  r.get("/conversations/:id/history", async (ctx) => {
    // Return events + the rolling integrity checksum through the last one, so a
    // streaming client can verify it has replayed the complete, in-order log
    // (and reconcile against live events' prevChecksum). Falls back gracefully
    // for stores without the checksum variant (in-memory test stores).
    const events: AguiEvent[] = [];
    let checksum = EMPTY_CHECKSUM;
    if (store.readEventsWithChecksum) {
      for await (const c of store.readEventsWithChecksum(ctx.params.id)) {
        events.push(c.event);
        checksum = c.checksum;
      }
    } else {
      for await (const e of store.readEvents(ctx.params.id)) events.push(e);
      checksum = chainAll(events);
    }
    return { json: { events, checksum } };
  });

  r.get("/conversations/:id/events", async (ctx) => {
    // SSE — the server owns the connection; returns void (no JSON result).
    await server.subscribeSSE(ctx.params.id, ctx.res);
  });

  // Integrity stream: replay the full log (each event + its rolling checksum),
  // then stay open and forward live appends with their checksums. Plain JSON SSE
  // (NOT the @ag-ui encoder — this carries our integrity envelope, which the
  // @ag-ui client would reject). The UI uses this to render reliably AND to
  // self-heal: if a live event's prevChecksum != the checksum it holds, it has a
  // gap and refetches history. Single ordered stream → no replay-vs-live race.
  r.get("/conversations/:id/events.integrity", async (ctx) => {
    const id = ctx.params.id;
    const { res } = ctx;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (frame: unknown) => res.write(`data: ${JSON.stringify(frame)}\n\n`);

    // Subscribe to live appends FIRST so nothing emitted during replay is lost;
    // buffer them until replay is done, then flush + go live. Dedup by checksum
    // (an event seen in replay won't be re-sent live).
    const seen = new Set<string>();
    let live = false;
    const buffer: ChecksummedEvent[] = [];
    const unsub = store.onAppend?.((evId, c) => {
      if (evId !== id) return;
      if (!live) buffer.push(c);
      else if (!seen.has(c.checksum)) {
        seen.add(c.checksum);
        send({ kind: "event", ...c });
      }
    });

    // Replay persisted history with checksums.
    if (store.readEventsWithChecksum) {
      for await (const c of store.readEventsWithChecksum(id)) {
        seen.add(c.checksum);
        send({ kind: "event", ...c });
      }
    }
    // Flush anything that arrived during replay, then go live.
    for (const c of buffer) {
      if (!seen.has(c.checksum)) {
        seen.add(c.checksum);
        send({ kind: "event", ...c });
      }
    }
    live = true;
    // Mark the end of the initial replay so the client knows it's caught up.
    send({ kind: "synced" });

    ctx.req.on("close", () => unsub?.());
  });

  r.post("/conversations/:id/permission/:toolCallId", async (ctx) => {
    const body = await ctx.body<{ optionId?: string }>();
    if (!body.optionId) return { status: 400, json: { error: "optionId required" } };
    await deps.answerPermission(ctx.params.id, ctx.params.toolCallId, body.optionId);
    return { status: 204, json: null };
  });

  return r;
}
