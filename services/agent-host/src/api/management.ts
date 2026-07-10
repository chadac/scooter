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
import type { IncomingMessage, ServerResponse } from "node:http";

import { createRouter, type Router, type ResolveUser } from "../http/router.js";
import type { SessionManager, Conversation } from "../session/manager.js";
import type { ConversationStore, ChecksummedEvent, ConversationLink } from "../session/manager.js";
import { tailByRuns } from "../session/eventWindow.js";
import type { AguiServer } from "../agui/server.js";
import type { AguiEvent, ApproverIdentity, SessionBridge } from "../bridge.js";
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
  /** Answer a pending tool permission (wired to the bridge in index.ts). `approver`
   *  is the identity of the human answering (for an AWS interrupt, the broker
   *  authorizes them). */
  answerPermission: (sessionId: string, toolCallId: string, optionId: string, approver?: ApproverIdentity) => Promise<void>;
  /** Approve/deny a broker AWS request after the user answers the interrupt
   *  (POSTs to the broker's /aws/{id}/approve|deny). `approver` is the identity of
   *  the human who answered — the broker authorizes the configured claim
   *  (email/id/name) via OpenFGA. Optional. Returns the broker's error detail (a
   *  provisioning failure) so the caller can feed it back to the agent. */
  resolveAwsRequest?: (
    sessionId: string,
    requestId: string,
    approved: boolean,
    approver: ApproverIdentity,
  ) => Promise<void>;
  /** Read-only: may `approver` (the VIEWING user) approve this AWS request? Powers
   *  the UI's greyed-out Approve button. Per-viewer — the interrupt is raised once
   *  server-side but seen by many users. Fails closed (false) broker-side. Optional
   *  (defaults to allowed when unwired / no broker). */
  canApproveAwsRequest?: (
    sessionId: string,
    requestId: string,
    approver: ApproverIdentity,
  ) => Promise<boolean>;
  /** Model catalog for per-conversation selection: the host default + the set
   *  offered to clients. Empty list = only the default is selectable. */
  models?: { default?: string; available: string[] };
  /** Raw handler for the agent-self-modify MCP endpoint (goose's
   *  modify_environment tool). It writes the response itself (the MCP transport
   *  streams), so it takes req/res directly. Optional (self-modify off). */
  mcpHandler?: (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void>;
  /** How to resolve the caller's identity per request (provider-agnostic; may be
   *  store-enriched). Defaults to the env-configured resolver (header/alb-oidc). */
  resolveUser?: ResolveUser;
}

/** The fields of a broker AWS request needed to render its approval interrupt.
 *  Matches the broker's request-view + the /aws-request POST body. */
export interface AwsRequestSummary {
  request_id: string;
  target_account?: string;
  risk_level?: string;
  policy_summary?: string;
  justification?: string;
}

/** Raise the Approve/Deny interrupt for a broker AWS request on a conversation's
 *  bridge, wiring the answer back to the broker via `resolveAwsRequest`. Shared by
 *  the /aws-request route (broker notifies at request time) AND the revive re-raise
 *  (index.ts onRevived, which rediscovers PENDING requests after a pod rollout
 *  dropped the in-memory interrupt). Keeping ONE builder means both paths produce an
 *  identical interrupt (same id/options/metadata/answer-routing). */
export function raiseAwsApprovalInterrupt(
  bridge: SessionBridge,
  conversationId: string,
  req: AwsRequestSummary,
  resolveAwsRequest?: ManagementDeps["resolveAwsRequest"],
): void {
  const summary =
    `Scooter is requesting AWS access to ${req.target_account} ` +
    `(risk: ${req.risk_level}).\n${req.policy_summary || ""}\n` +
    `Reason: ${req.justification || "(none)"}`;
  bridge.raiseInterrupt({
    id: req.request_id,
    message: summary,
    options: [
      { optionId: "approve", name: "Approve", kind: "allow_once" },
      { optionId: "deny", name: "Deny", kind: "reject_once" },
    ],
    // Tag it AWS so the UI runs a per-viewer can-approve check (greys the Approve
    // button for users who can't approve). requestId == the interrupt id, but carry
    // it explicitly so the UI needn't assume that.
    metadata: { aws: true, requestId: req.request_id },
    onAnswer: (optionId, approver) => {
      // The approver is the HUMAN who answered (from the permission route), not the
      // conversation owner — the broker authorizes the configured claim. Fall back
      // to the conversation id when there's no identity (anonymous / FGA-off / dev).
      const approverIdentity = approver ?? { id: conversationId };
      // resolveAwsRequest THROWS on a dropped approval (token unreadable / broker
      // 4xx-5xx); fire-and-forget, so handle the rejection — a swallowed one silently
      // loses the user's security decision.
      void resolveAwsRequest?.(conversationId, req.request_id, optionId === "approve", approverIdentity).catch(
        (err) => {
          // eslint-disable-next-line no-console
          console.error(
            `[agent-host] AWS approval NOT recorded for ${conversationId} (request ${req.request_id}, ${optionId}):`,
            err,
          );
        },
      );
    },
  });
}

export function createManagementApi(deps: ManagementDeps): Router {
  const { sessions, store, server } = deps;
  const models = deps.models ?? { available: [] };
  const r = createRouter(deps.resolveUser);

  // The agent-self-modify MCP endpoint (goose calls modify_environment here). The
  // MCP StreamableHTTP transport owns the response, so this handler reads the body
  // and hands req/res to it, then returns void (response already written).
  if (deps.mcpHandler) {
    const mcp = deps.mcpHandler;
    const mcpRoute = async (ctx: { req: IncomingMessage; res: ServerResponse; body: <T>() => Promise<T> }) => {
      const body = await ctx.body<unknown>().catch(() => undefined);
      await mcp(ctx.req, ctx.res, body);
    };
    r.post("/mcp", mcpRoute as never);
    r.get("/mcp", mcpRoute as never); // MCP also uses GET for the SSE stream
  }

  // Who the caller is, per the trusted ingress identity header (anonymous when
  // none). The UI uses this to label conversations as "mine" + show the user.
  r.get("/whoami", (ctx) => ({
    json: { id: ctx.user.id, email: ctx.user.email ?? null, anonymous: ctx.user.anonymous },
  }));

  // The model catalog — a UI populates its selector from this.
  r.get("/models", () => ({
    json: { default: models.default ?? null, available: models.available },
  }));

  // VIEW FILTER (not access control — conversations are public):
  //   ?scope=mine (default) -> conversations the caller owns + unowned/public ones.
  //   ?scope=all            -> everything.
  // An anonymous caller (no identity header) sees everything either way, so
  // single-user / local-dev is unchanged. Extracted so the list route AND the
  // /conversations/events push stream share ONE predicate — the stream is a
  // security boundary and must not leak more than the poll would.
  const visibleFilter = (ctx: { user: { anonymous: boolean; id: string }; query: URLSearchParams }) => {
    const scope = ctx.query.get("scope") ?? "mine";
    const user = ctx.user;
    return (c: { owner?: string }) =>
      scope === "all" || user.anonymous || c.owner == null || c.owner === user.id;
  };

  // Enrich a conversation with the DISTINCT providers it links to, so the sidebar
  // can show a per-row provider icon without an extra /links fetch. Links are
  // file-backed (cheap). Shared by the list route and the push stream.
  const withSources = async (c: Conversation, now: number) => {
    const links = (await store.listLinks?.(c.id)) ?? [];
    const sources = [...new Set(links.map((l) => l.source))].sort();
    return { ...view(c, now), sources };
  };

  r.get("/conversations", async (ctx) => {
    const now = Date.now();
    const list = sessions.list().filter(visibleFilter(ctx));
    const json = await Promise.all(list.map((c) => withSources(c, now)));
    return { json };
  });

  // GET /conversations/events — the conversation-LIST push stream. Emits an
  // initial { kind: "snapshot", conversations } (the visible list, same scope /
  // view-filter as GET /conversations), then { kind: "upsert", conversation } on
  // each SessionManager.onConversationChange (new conversation / title change),
  // filtered by the caller's scope so it never leaks more than the poll. Makes a
  // Slack thread appear in the sidebar instantly instead of on the 10s poll.
  r.get("/conversations/events", async (ctx) => {
    const { res } = ctx;
    // Bind the view-filter to THIS caller's scope+identity once — the same
    // predicate the REST list uses (a security boundary: the stream must not
    // emit conversations the poll would hide).
    const visible = visibleFilter(ctx);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (frame: unknown) => res.write(`data: ${JSON.stringify(frame)}\n\n`);

    // Initial snapshot: the visible list, each enriched with its link sources
    // (same shape as GET /conversations).
    const now = Date.now();
    const conversations = await Promise.all(
      sessions.list().filter(visible).map((c) => withSources(c, now)),
    );
    send({ kind: "snapshot", conversations });

    // Then push each lifecycle change (new conversation / title change) that
    // passes the filter as an upsert. Enrichment (sources) happens here, not in
    // the emitter, so the manager stays cheap. Emit the frame SYNCHRONOUSLY (a
    // base view with empty sources) so the change is on the wire immediately;
    // then, if the store has links, patch `sources` and re-emit. A brand-new
    // conversation almost never has links yet, so the first frame is usually the
    // only one — but the two-phase emit means a webhook-linked conversation still
    // gets its provider icon without waiting on the next poll/snapshot.
    const unsub = sessions.onConversationChange((c) => {
      if (!visible(c)) return;
      const now = Date.now();
      send({ kind: "upsert", conversation: { ...view(c, now), sources: [] as string[] } });
      void withSources(c, now).then((conversation) => {
        if (conversation.sources.length) send({ kind: "upsert", conversation });
      });
    });

    ctx.req.on("close", () => unsub());
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

  // Stop the RUNNING turn — the UI's Stop button. cancel() ends the in-flight run
  // cleanly (kills the active tool call via the exec seam, ACP session/cancel, and
  // emits a RUN_FINISHED{cancelled:true}). No-op-OK: a conversation with no live
  // bridge or nothing running still returns 202 (stopping "nothing" succeeded), so
  // a stale Stop click never errors. 404 only for a genuinely unknown conversation.
  r.post("/conversations/:id/cancel", async (ctx) => {
    const conv = sessions.get(ctx.params.id);
    if (!conv) return { status: 404, json: { error: "not found" } };
    await conv.bridge?.cancel();
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

  r.get("/conversations/:id/tail", async (ctx) => {
    // A fast first-paint window: the events from the last N runs (default 8), so a
    // client opening a LONG conversation can render the latest context instantly
    // instead of waiting for the whole log to stream + fold. Windowed on RUN
    // boundaries so every message/tool call in the tail is complete and folds
    // identically to a full replay — the client then reconciles against the full
    // integrity stream with no visible change. NOT checksummed (a partial window).
    const runsParam = Number(ctx.query.get("runs"));
    const runs = Number.isFinite(runsParam) && runsParam > 0 ? Math.min(runsParam, 100) : 8;
    // Fast path: read ONLY the tail (scan from the end, parse the window). Falls
    // back to reading + windowing the whole log for stores without the tail reader
    // (in-memory test stores) — those logs are tiny so the cost is irrelevant.
    let events: AguiEvent[];
    if (store.readEventsTail) {
      events = await store.readEventsTail(ctx.params.id, runs);
    } else {
      const all: AguiEvent[] = [];
      for await (const e of store.readEvents(ctx.params.id)) all.push(e);
      events = tailByRuns(all, runs);
    }
    return { json: { events, runs } };
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
    // The answering user's identity — the broker authorizes THIS person for an AWS
    // approval (not the conversation owner). Anonymous → no identity claims.
    const approver = ctx.user.anonymous
      ? undefined
      : { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name };
    await deps.answerPermission(ctx.params.id, ctx.params.toolCallId, body.optionId, approver);
    return { status: 204, json: null };
  });

  // May the CURRENT viewer approve this AWS request? The UI calls this per pending
  // AWS interrupt to decide whether to grey out the Approve button (per-viewer: the
  // interrupt is raised once server-side but seen by many users). Anonymous users
  // can never approve (no identity to authorize) → canApprove:false, greyed button.
  r.get("/conversations/:id/aws-request/:requestId/can-approve", async (ctx) => {
    if (!deps.canApproveAwsRequest) return { json: { canApprove: true } }; // unwired → don't block
    if (ctx.user.anonymous) return { json: { canApprove: false } };
    const approver = { id: ctx.user.id, email: ctx.user.email, name: ctx.user.name };
    const canApprove = await deps
      .canApproveAwsRequest(ctx.params.id, ctx.params.requestId, approver)
      .catch(() => false); // fail closed (greyed) on any error
    return { json: { canApprove } };
  });

  // External resource links (the GitHub PR / Slack thread a conversation came
  // from). The webhooks service POSTs them on create; the UI GETs them for the
  // linked-resources panel.
  // Resolve a conversation id that MIGHT be the broker's short DNS hash
  // (`sandbox-{shortId}`) rather than the full threadId the store keys by. The
  // broker (auto-link injector + explicit /link) identifies the conversation
  // from the SA token, which carries the short id — a plain store.*(ctx.params.id)
  // would miss it (the same shortId mismatch that broke aws-request). Falls back
  // to the raw id for UI/webhooks callers that already pass the full threadId.
  const resolveConvId = async (id: string): Promise<string | null> => {
    const conv = sessions.get(id) ?? (await sessions.getByShortId(id));
    return conv?.id ?? null;
  };

  r.get("/conversations/:id/links", async (ctx) => {
    const id = (await resolveConvId(ctx.params.id)) ?? ctx.params.id;
    const links = (await store.listLinks?.(id)) ?? [];
    return { json: { links } };
  });

  r.post("/conversations/:id/links", async (ctx) => {
    const body = await ctx.body<{
      source?: string;
      resourceType?: string;
      url?: string;
      title?: string;
      ref?: ConversationLink["ref"];
    }>();
    if (!body.source || !body.resourceType) {
      return { status: 400, json: { error: "source and resourceType required" } };
    }
    const id = await resolveConvId(ctx.params.id);
    if (!id) return { status: 404, json: { error: "unknown conversation" } };
    await store.addLink?.(id, {
      source: body.source,
      resourceType: body.resourceType,
      url: body.url,
      title: body.title,
      ref: body.ref,
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
    // Resolve the conversation. The BROKER identifies it by the SHORT DNS-safe
    // hash (from the sandbox SA name `sandbox-{shortId}`), NOT the full threadId
    // the session map is keyed by — so a plain get(ctx.params.id) MISSES and the
    // approval 404s (the "window never appears" root cause). Try the full id first
    // (webhooks/UI use it), then fall back to the short-id resolution (which also
    // hydrates a persisted-but-evicted conversation).
    const conv =
      sessions.get(ctx.params.id) ?? (await sessions.getByShortId(ctx.params.id));
    if (!conv) {
      // A genuinely unknown conversation — nothing to raise the interrupt on.
      return { status: 404, json: { error: "unknown conversation" } };
    }
    // The conversation exists but its in-memory BRIDGE may be absent — it was
    // idle-suspended, or hydrated-but-not-revived after an agent-host restart, or
    // torn down by a model switch. The agent that called `scooter-aws request` is
    // still running in the sandbox, so we MUST NOT drop the approval on the floor:
    // revive to rebuild the bridge, then raise. Without this the route dropped it
    // and the broker (fire-and-forget) swallowed it — "the approval window never
    // appeared." raiseInterrupt persists the interrupt, so it also survives a
    // reload once raised. Key off the RESOLVED conversation's real id (conv.id),
    // not ctx.params.id, which may be the short hash.
    let bridge = sessions.get(conv.id)?.bridge;
    if (!bridge) {
      try {
        await sessions.revive(conv.id);
        bridge = sessions.get(conv.id)?.bridge;
      } catch (err) {
        console.error(`[agent-host] aws-request could not revive ${conv.id}:`, err);
      }
    }
    if (!bridge) return { status: 503, json: { error: "could not activate conversation to raise the approval" } };

    raiseAwsApprovalInterrupt(bridge, conv.id, body as AwsRequestSummary, deps.resolveAwsRequest);
    return { status: 202, json: { ok: true } };
  });

  return r;
}
