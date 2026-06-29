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
    owner: c.owner,
    sandbox: { name: c.sandbox.name, namespace: c.sandbox.namespace },
  };
}

export interface ManagementDeps {
  sessions: SessionManager;
  store: ConversationStore;
  server: AguiServer;
  /** Answer a pending tool permission (wired to the bridge in index.ts). */
  answerPermission: (sessionId: string, toolCallId: string, optionId: string) => Promise<void>;
  /** Approve/deny a broker AWS request after the user answers the interrupt
   *  (POSTs to the broker's /aws/{id}/approve|deny). `approver` is the real user
   *  id (the conversation owner) the broker enforces via OpenFGA. Optional. */
  resolveAwsRequest?: (sessionId: string, requestId: string, approved: boolean, approver: string) => Promise<void>;
  /** Model catalog for per-conversation selection: the host default + the set
   *  offered to clients. Empty list = only the default is selectable. */
  models?: { default?: string; available: string[] };
}

export function createManagementApi(deps: ManagementDeps): Router {
  const { sessions, store, server } = deps;
  const models = deps.models ?? { available: [] };
  const r = createRouter();

  // Who the caller is, per the trusted ingress identity header (anonymous when
  // none). The UI uses this to label conversations as "mine" + show the user.
  r.get("/whoami", (ctx) => ({
    json: { id: ctx.user.id, email: ctx.user.email ?? null, anonymous: ctx.user.anonymous },
  }));

  // The model catalog — a UI populates its selector from this.
  r.get("/models", () => ({
    json: { default: models.default ?? null, available: models.available },
  }));

  r.get("/conversations", async (ctx) => {
    const now = Date.now();
    // VIEW FILTER (not access control — conversations are public):
    //   ?scope=mine (default) -> conversations the caller owns + unowned/public ones.
    //   ?scope=all            -> everything.
    // An anonymous caller (no identity header) sees everything either way, so
    // single-user / local-dev is unchanged.
    const scope = ctx.query.get("scope") ?? "mine";
    const user = ctx.user;
    const visible = (c: { owner?: string }) =>
      scope === "all" || user.anonymous || c.owner == null || c.owner === user.id;

    const list = sessions.list().filter(visible);
    // Enrich each conversation with the DISTINCT providers it links to, so the
    // sidebar can show a per-row provider icon without an extra /links fetch per
    // conversation. Links are file-backed (cheap); fetch them in parallel.
    const json = await Promise.all(
      list.map(async (c) => {
        const links = (await store.listLinks?.(c.id)) ?? [];
        const sources = [...new Set(links.map((l) => l.source))].sort();
        return { ...view(c, now), sources };
      }),
    );
    return { json };
  });

  r.post("/conversations", async (ctx) => {
    const body = await ctx.body<{ threadId?: string; title?: string; model?: string }>();
    const threadId = body.threadId ?? randomUUID();
    // Reject an unknown model rather than silently falling back, so a client
    // mistake is visible.
    if (body.model && body.model !== models.default && !models.available.includes(body.model)) {
      return { status: 400, json: { error: `unknown model: ${body.model}` } };
    }
    // Stamp the creating user as the owner (for the "my conversations" filter).
    const owner = ctx.user.anonymous ? undefined : ctx.user.id;
    const conv = await sessions.start(threadId, body.model, owner);
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
    // Unknown conversation -> 404 so the client stops reconnecting (a deleted
    // conversation otherwise loops retries forever).
    if (!sessions.get(id)) {
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
      return;
    }
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

  // External resource links (the GitHub PR / Slack thread a conversation came
  // from). The webhooks service POSTs them on create; the UI GETs them for the
  // linked-resources panel.
  r.get("/conversations/:id/links", async (ctx) => {
    const links = (await store.listLinks?.(ctx.params.id)) ?? [];
    return { json: { links } };
  });

  r.post("/conversations/:id/links", async (ctx) => {
    const body = await ctx.body<{ source?: string; resourceType?: string; url?: string; title?: string }>();
    if (!body.source || !body.resourceType) {
      return { status: 400, json: { error: "source and resourceType required" } };
    }
    await store.addLink?.(ctx.params.id, {
      source: body.source,
      resourceType: body.resourceType,
      url: body.url,
      title: body.title,
    });
    return { status: 201, json: { ok: true } };
  });

  // The broker calls this when an agent requests AWS access: raise an in-
  // conversation approval interrupt (Approve / Deny). The user's pick routes back
  // to the broker (approve/deny) via deps.resolveAwsRequest.
  r.post("/conversations/:id/aws-request", async (ctx) => {
    const body = await ctx.body<{
      request_id?: string;
      target_account?: string;
      risk_level?: string;
      policy_summary?: string;
      justification?: string;
    }>();
    if (!body.request_id) return { status: 400, json: { error: "request_id required" } };
    const conv = sessions.get(ctx.params.id);
    const bridge = conv?.bridge;
    if (!bridge) return { status: 404, json: { error: "no active conversation" } };

    const summary =
      `Scooter is requesting AWS access to ${body.target_account} ` +
      `(risk: ${body.risk_level}).\n${body.policy_summary || ""}\n` +
      `Reason: ${body.justification || "(none)"}`;
    bridge.raiseInterrupt({
      id: body.request_id,
      message: summary,
      options: [
        { optionId: "approve", name: "Approve", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
      onAnswer: (optionId) => {
        // The approver is the conversation's OWNER (the human who owns this
        // in-conversation approval); the broker enforces their rights via
        // OpenFGA. Fall back to the conversation id when unowned (FGA-off / dev).
        const approver = conv?.owner || ctx.params.id;
        void deps.resolveAwsRequest?.(ctx.params.id, body.request_id!, optionId === "approve", approver);
      },
    });
    return { status: 202, json: { ok: true } };
  });

  return r;
}
