/**
 * AG-UI server: streams AG-UI events from the agent-host to the browser over SSE,
 * with prompts and permission answers arriving over POST. Events are encoded with
 * @ag-ui/encoder so the wire format is the canonical AG-UI SSE framing that
 * assistant-ui's AG-UI runtime consumes.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

import { EventEncoder } from "@ag-ui/encoder";
import type { BaseEvent } from "@ag-ui/core";

import type { AguiEvent, ApproverIdentity } from "../bridge.js";
import type { SessionId, ThreadId } from "../types.js";
import type { Router } from "../http/router.js";
import { sandboxLabelOf, type WebServiceProxy } from "../proxy/webServiceProxy.js";
import { logger, withConversation } from "../log.js";
import { isDbUnavailable } from "../db/pgPool.js";
import type { AccessCheck } from "../session/access.js";

const log = logger("agui");

/** How long the /agui resume branch waits for the resumed run to stream anything before closing with a RUN_ERROR, read per call so SCOOTER_RESUME_GUARD_MS can override it. */
const resumeStreamGuardMs = (): number => Number(process.env.SCOOTER_RESUME_GUARD_MS ?? 60_000);

// Outlasts the conversation-router's 30s idle-connection timeout (upstreamTransport), so the
// router never reuses a keep-alive connection this server is closing.
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/** A raw inbound image on a user message, before the promptHandler stores it in the AssetStore. */
export interface InboundImage {
  data: string; // base64
  mimeType: string;
}

/** A non-image attachment (base64 bytes) that the agent-host materializes into the sandbox at /workspace/uploads/<name>. */
export interface InboundFile {
  name: string;
  data: string; // base64
  mimeType: string;
}

/** One part of a multimodal message content array; shapes other than text, image and file are ignored. */
export type ContentPart =
  | { type: "text"; text?: string }
  | { type: "image"; data?: string; mimeType?: string; image?: string; [k: string]: unknown }
  | { type: "file"; name?: string; data?: string; mimeType?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** Normalize a message's `content` (string or ContentPart[]) into prompt text, inbound images and inbound files. */
export function normalizeContent(content: string | ContentPart[] | undefined): {
  text: string;
  images: InboundImage[];
  files: InboundFile[];
} {
  if (content == null) return { text: "", images: [], files: [] };
  if (typeof content === "string") return { text: content, images: [], files: [] };
  const texts: string[] = [];
  const images: InboundImage[] = [];
  const files: InboundFile[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
      texts.push((part as { text: string }).text);
    } else if (part.type === "image") {
      // Accept {data, mimeType} or an assistant-ui {image} data URL.
      const p = part as { data?: string; mimeType?: string; image?: string };
      const parsed = p.data && p.mimeType
        ? { data: p.data, mimeType: p.mimeType }
        : p.image
          ? parseDataUrl(p.image)
          : null;
      if (parsed) images.push(parsed);
    } else if (part.type === "file") {
      // A binary attachment: {name, data(base64), mimeType}.
      const p = part as { name?: string; data?: string; mimeType?: string };
      if (p.name && p.data) {
        files.push({ name: p.name, data: p.data, mimeType: p.mimeType || "application/octet-stream" });
      }
    }
  }
  return { text: texts.join("\n\n"), images, files };
}

/** Parse a `data:<mime>;base64,<data>` URL into {data, mimeType}, or null. */
function parseDataUrl(url: string): InboundImage | null {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(url);
  return m ? { mimeType: m[1], data: m[2] } : null;
}

/** A user prompt arriving from the UI (AG-UI RunAgentInput, subset). */
export interface RunAgentInput {
  threadId: ThreadId;
  text: string;
  /** Per-conversation model pick from the X-Agent-Model header; undefined keeps the current model. */
  model?: string;
  /** The provider the user explicitly picked, from "<provider>:<model>". */
  provider?: string;
  /** Priority tier (PRIORITY_INTERRUPT) for a force-interrupting message, set by a webhooks
   *  `@scooter` mention to an active conversation so it can preempt a stuck turn and never by
   *  the UI; undefined/0 waits its turn. */
  priority?: number;
  /** The Scooter user id to own a webhook-spawned conversation, honored only when the caller is the TokenReview-verified webhooks service. */
  owner?: string;
  /** Images attached to the latest user message (base64). */
  images?: InboundImage[];
  /** Binary file attachments on the latest user message (base64), materialized into the sandbox at /workspace/uploads/<name>. */
  files?: InboundFile[];
  /** System message source set by a platform caller (webhooks, scheduler), so the agent sees a "system event" and the UI can hide it; harmless if spoofed. */
  source?: string;
  /** Who sent a webhook message, honored only from the TokenReview-verified webhooks caller. */
  sender?: InboundSender;
}

/** A webhook message's sender as a contrib reports it: the platform's stable id, plus the
 *  level its platform signals prove. */
export interface InboundSender {
  provider: string;
  externalId: string;
  handle: string;
  displayName?: string;
  level: number;
}

/** The sender providers a contrib may report; "scooter" identities are never sent in. */
const SENDER_PROVIDERS = new Set(["github", "gitlab", "slack", "jira"]);
/** member..unknown: self (0) and vouched (20) come only from the agent-host's own state. */
const CONTRIB_LEVELS = new Set([40, 60, 80, 100]);

/** `raw` as an InboundSender, or undefined if any field is missing or out of range. */
export function parseInboundSender(raw: unknown): InboundSender | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.provider !== "string" || !SENDER_PROVIDERS.has(r.provider)) return undefined;
  if (typeof r.externalId !== "string" || r.externalId === "") return undefined;
  if (typeof r.handle !== "string") return undefined;
  if (typeof r.level !== "number" || !CONTRIB_LEVELS.has(r.level)) return undefined;
  const displayName = typeof r.displayName === "string" && r.displayName !== "" ? r.displayName : undefined;
  return { provider: r.provider, externalId: r.externalId, handle: r.handle, level: r.level, ...(displayName ? { displayName } : {}) };
}

/** One connected UI client subscribed to a session's event stream. */
export interface AguiConnection {
  readonly sessionId: SessionId;
  send(event: AguiEvent): void;
  close(): void;
}

/** The result of handling one resume entry; `ok:false` makes the /agui resume branch close the SSE with a RUN_ERROR rather than leave it open and silent. */
export interface ResumeOutcome {
  ok: boolean;
  reason?: string;
  /** Answered with nothing to resume; close the stream now. */
  settled?: boolean;
}

/** The largest result one resume may carry, serialized. */
const MAX_RESULT_BYTES = 16 * 1024;

/** The `result` object from a resume payload, or undefined when there is none or it is too large. */
export function interruptResult(payload: unknown): Record<string, unknown> | undefined {
  const raw = (payload as { result?: unknown } | undefined)?.result;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return JSON.stringify(raw).length <= MAX_RESULT_BYTES ? (raw as Record<string, unknown>) : undefined;
}

/** What the ingress identity resolver returns; `email`/`name` must be carried when present, since an approval is authorized against a configured claim. */
export interface ResolvedUser {
  id: string;
  email?: string;
  name?: string;
  anonymous: boolean;
}

export interface AguiServer {
  listen(port: number): Promise<void>;
  /** The bound port after listen(), or undefined if not listening. */
  port(): number | undefined;
  close(): Promise<void>;
  onPrompt(handler: (sessionId: SessionId, input: RunAgentInput) => Promise<void>): void;
  /** Answer a pending permission request (toolCallId -> optionId). */
  /** Resume a paused run with the user's interrupt answer; `ok:false` means the run could not accept it, so the resume branch closes the SSE with a RUN_ERROR. */
  onResume(
    handler: (
      sessionId: SessionId,
      entry: { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown },
      /** The human who answered, from the ingress identity on this request; undefined only when anonymous. */
      approver?: ApproverIdentity,
    ) => Promise<ResumeOutcome>,
  ): void;
  broadcast(sessionId: SessionId, event: AguiEvent): void;
  /** Replay the persisted event log to a newly-attached connection. */
  onAttach(handler: (sessionId: SessionId, conn: AguiConnection) => Promise<void>): void;
  /** Mount a management router; tried before the built-in AG-UI routes. */
  use(router: Router): void;
  /** Mount the web-service reverse proxy (/c/<id>/<service>/...), an HTTP fallback before the 404 and the `upgrade` handler for WebSocket services. */
  useProxy(proxy: WebServiceProxy): void;
  /** Register a raw WebSocket upgrade handler for an exact pathname, consulted before the proxy; the handler owns the socket. */
  onUpgrade(pathname: string, handler: (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void): void;
  /** Set the verifier that decides whether a /agui request is the trusted webhooks caller, gating the privileged `owner` field. */
  useOwnerVerifier(verify: (req: import("node:http").IncomingMessage) => Promise<boolean>): void;
  /** Set the visibility check run before /agui and /sessions/:id/* touch a conversation. */
  useAccessCheck(check: AccessCheck): void;
  /** Resolve the caller's ingress identity so a conversation created via POST /agui is owned by the human who created it. */
  useIdentityResolver(resolve: (req: import("node:http").IncomingMessage) => ResolvedUser | Promise<ResolvedUser>): void;
  /** Attach an SSE response to a session's persistent event stream, returning once replay is done. */
  subscribeSSE(sessionId: SessionId, res: ServerResponse): Promise<void>;
}

/** An AguiEvent is a BaseEvent once `type` is the discriminator. */
function toBaseEvent(event: AguiEvent): BaseEvent {
  return event as unknown as BaseEvent;
}

export function createAguiServer(): AguiServer {
  const encoder = new EventEncoder();
  const connections = new Map<SessionId, Set<ServerResponse>>();

  let promptHandler:
    | ((sessionId: SessionId, input: RunAgentInput) => Promise<void>)
    | undefined;
  let resumeHandler:
    | ((
        sessionId: SessionId,
        entry: { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown },
        approver?: ApproverIdentity,
      ) => Promise<ResumeOutcome>)
    | undefined;
  let attachHandler:
    | ((sessionId: SessionId, conn: AguiConnection) => Promise<void>)
    | undefined;

  let server: Server | undefined;
  let mountedRouter: Router | undefined;
  let mountedProxy: WebServiceProxy | undefined;
  // Exact-pathname WS upgrade handlers, consulted before the proxy on `upgrade`.
  const upgradeHandlers = new Map<string, (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void>();
  let ownerVerifier: ((req: IncomingMessage) => Promise<boolean>) | undefined;
  let accessCheck: AccessCheck | undefined;
  let identityResolver: ((req: IncomingMessage) => ResolvedUser | Promise<ResolvedUser>) | undefined;

  /** Resolve the caller's ingress identity, degrading to undefined (anonymous) on any throw, synchronous or not. */
  const resolveUserSafely = async (req: IncomingMessage): Promise<ResolvedUser | undefined> => {
    if (!identityResolver) return undefined;
    try {
      return await identityResolver(req);
    } catch {
      return undefined;
    }
  };

  // What each POST /agui stream carried, for the "agui stream closed" line.
  const streamStats = new WeakMap<ServerResponse, { events: number; last?: string }>();

  const write = (res: ServerResponse, event: AguiEvent) => {
    res.write(encoder.encodeSSE(toBaseEvent(event)));
    const st = streamStats.get(res);
    if (st) {
      st.events++;
      st.last = event.type;
    }
  };

  const subscribeSSE = async (sessionId: SessionId, res: ServerResponse): Promise<void> => {
    res.writeHead(200, {
      "Content-Type": encoder.getContentType(),
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    let set = connections.get(sessionId);
    if (!set) connections.set(sessionId, (set = new Set()));
    set.add(res);
    res.req.on("close", () => set!.delete(res));
    const conn: AguiConnection = {
      sessionId,
      send: (e) => write(res, e),
      close: () => res.end(),
    };
    await attachHandler?.(sessionId, conn); // replay the event log
  };

  // Connections opened via POST /agui are run-scoped and close when the run ends.
  const runScoped = new WeakSet<ServerResponse>();

  // Broadcast a run's live events only to run-scoped connections, since a stray
  // RUN_STARTED on a persistent connection would be rejected by an idle @ag-ui client;
  // persistent viewers get external runs through the integrity stream instead.
  const broadcast = (sessionId: SessionId, event: AguiEvent) => {
    const set = connections.get(sessionId);
    if (!set) return;
    const terminal = event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";
    for (const res of set) {
      if (!runScoped.has(res)) continue; // integrity stream serves persistent conns
      write(res, event);
      if (terminal) {
        set.delete(res);
        res.end();
      }
    }
  };

  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });

  /** 404 (as for a missing conversation) and true when the caller may not see `sessionId`; 503 and true when the check could not run. */
  const refuseHidden = async (req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<boolean> => {
    if (!accessCheck || !sessionId) return false;
    try {
      const user = await resolveUserSafely(req);
      if ((await accessCheck(sessionId, req, user)) !== "deny") return false;
      res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not found"}');
    } catch (err) {
      log.errorWith("visibility check failed; refusing", err, { conversation_id: sessionId });
      res.writeHead(503, { "Content-Type": "application/json" }).end('{"error":"could not check access"}');
    }
    return true;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    // A request routed from a sandbox host reaches web services and nothing else, even if the
    // router let something else through.
    if (sandboxLabelOf(req) !== undefined) {
      if (mountedProxy && mountedProxy.matches(url.pathname)) await mountedProxy.handleHttp(req, res);
      else res.writeHead(404).end();
      return;
    }

    // The router's cluster-internal web-service routes (direct proxying of sandbox hosts).
    if (mountedProxy && (await mountedProxy.handleInternal(req, res))) return;

    // Management API (mounted router) is tried first.
    if (mountedRouter && (await mountedRouter.handle(req, res))) return;

    // GET /healthz is the readiness probe.
    if (req.method === "GET" && parts[0] === "healthz") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
      return;
    }

    // POST /agui is the standard AG-UI HttpAgent protocol: accept a RunAgentInput and
    // stream this run's events back over SSE.
    if (req.method === "POST" && parts[0] === "agui") {
      const input = JSON.parse((await readBody(req)) || "{}") as {
        threadId: string;
        runId?: string;
        // content is a plain string or an array of multimodal content parts.
        messages?: Array<{ role: string; content?: string | ContentPart[] }>;
        /** Priority tier for a force-interrupting message. */
        priority?: number;
        /** The Scooter user to own a webhook-spawned conversation, honored only for a TokenReview-verified caller. */
        owner?: string;
        /** Per-interrupt responses with which assistant-ui resumes a paused run instead of sending a new message. */
        resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>;
        /** System message source (webhooks/scheduler); absent means a human message. */
        source?: string;
        /** Who sent a webhook message; see RunAgentInput.sender. */
        sender?: unknown;
      };
      const sessionId = input.threadId;
      if (await refuseHidden(req, res, sessionId)) return;
      // One line per request and one per stream close: a prompt that commits a 200 and then
      // never runs (the e2e interrupt flakes) shows up as "received" followed by a close with
      // zero events, on the pod that took it.
      const kind = input.resume && input.resume.length > 0 ? "resume" : "prompt";
      const startedAt = Date.now();
      const stats = { events: 0 } as { events: number; last?: string };
      streamStats.set(res, stats);
      withConversation(sessionId, () =>
        log.info("agui request received", {
          kind,
          run_id: input.runId,
          resume_count: input.resume?.length ?? 0,
          has_source: input.source !== undefined,
        }),
      );
      res.on("close", () =>
        withConversation(sessionId, () =>
          log.info("agui stream closed", {
            kind,
            events: stats.events,
            last_event: stats.last ?? null,
            // false means the client went away before the server ended the stream.
            ended_by_server: res.writableEnded,
            duration_ms: Date.now() - startedAt,
          }),
        ),
      );
      res.writeHead(200, {
        "Content-Type": encoder.getContentType(),
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });

      // Subscribe this response to the session's events for the duration of the run.
      let set = connections.get(sessionId);
      if (!set) connections.set(sessionId, (set = new Set()));
      set.add(res);
      runScoped.add(res);
      req.on("close", () => set!.delete(res));

      // A resume (an answer to a pending interrupt) unpauses the still-blocked run, whose
      // continued events stream back over this SSE; no new prompt is started.
      if (input.resume && input.resume.length > 0) {
        // The answering human, resolved once for the batch, is who an approval interrupt
        // is authorized against; anonymous stays undefined rather than becoming a
        // synthetic principal.
        const answerer = await resolveUserSafely(req);
        const approver: ApproverIdentity | undefined =
          answerer && !answerer.anonymous
            ? { id: answerer.id, email: answerer.email, name: answerer.name }
            : undefined;
        const outcomes = await Promise.all(
          input.resume.map((r) => resumeHandler?.(sessionId, r, approver) ?? Promise.resolve({ ok: true } as ResumeOutcome)),
        );
        const failed = outcomes.find((o) => o && !o.ok);
        if (failed) {
          log.warn("resume could not be applied", { conversation_id: sessionId, reason: failed.reason });
          try {
            write(res, {
              type: "RUN_ERROR",
              message: `This approval could not be applied: ${failed.reason ?? "the run is no longer awaiting it"}.`,
            });
          } catch {
            /* stream already torn down */
          }
          set.delete(res);
          res.end();
          return;
        }
        if (outcomes.every((o) => o?.settled)) {
          set.delete(res);
          res.end();
          return;
        }
        // Keep the stream open for the resumed run, but close it with a RUN_ERROR if it
        // has streamed nothing by the deadline; broadcast() removes res from `set` on
        // the terminal event, so "still in set and writable" means nothing resumed.
        const guard = setTimeout(() => {
          if (!set.has(res) || res.writableEnded) return; // run already streamed/closed it
          try {
            write(res, {
              type: "RUN_ERROR",
              message: "This approval was accepted but the run did not resume; please try again.",
            });
          } catch {
            /* stream already torn down */
          }
          set.delete(res);
          res.end();
        }, resumeStreamGuardMs());
        // Never let the guard outlive the connection.
        res.on("close", () => clearTimeout(guard));
        return;
      }

      // The latest user message is the prompt.
      const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
      const { text, images, files } = normalizeContent(lastUser?.content);
      // The UI rides the per-conversation model on a header, since the assistant-ui
      // runtime drives the AG-UI body.
      const hdr = req.headers["x-agent-model"];
      const rawModel = (Array.isArray(hdr) ? hdr[0] : hdr) || undefined;
      // The picker sends "<provider>:<model>" when the catalog groups by provider so an
      // explicit pick can move a run off the highest-priority eligible provider, and only the
      // model travels on while provider selection keys on it via modelAllowedFor.
      const sep = rawModel ? rawModel.indexOf(":") : -1;
      const model = sep > 0 ? rawModel!.slice(sep + 1) : rawModel;
      const pickedProvider = sep > 0 ? rawModel!.slice(0, sep) : undefined;
      // Resolve the conversation owner stamped on first creation: an explicit `input.owner` is
      // honored only for the TokenReview-verified webhooks caller, otherwise the caller's
      // ingress identity (the same resolver /whoami uses) owns it, and anonymous leaves it
      // unowned.
      let owner: string | undefined;
      // Owner and sender are trusted only from the webhooks caller.
      const verified =
        (input.owner !== undefined || input.sender !== undefined) &&
        ownerVerifier !== undefined &&
        (await ownerVerifier(req).catch(() => false));
      // Untrusted or malformed senders are logged and dropped.
      const sender = verified ? parseInboundSender(input.sender) : undefined;
      if (input.sender !== undefined && !sender) {
        withConversation(sessionId, () => log.warn("dropped an untrusted or malformed sender", { verified }));
      }
      if (input.owner && verified) {
        owner = input.owner;
      } else {
        const user = await resolveUserSafely(req);
        if (user && !user.anonymous) owner = user.id;
      }
      // If promptHandler throws before the run emits a terminal event, the SSE 200 header
      // is already sent, so emit a RUN_ERROR on this stream and close it rather than let
      // the outer catch end it with an unparseable raw error.
      try {
        await promptHandler?.(sessionId, { threadId: sessionId, text, model, provider: pickedProvider, priority: input.priority, owner, images, files, source: input.source, sender });
        // promptHandler drives the run; RUN_FINISHED/RUN_ERROR close the stream.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // An unknown id is a caller bug rather than a run failure, but the SSE head is
        // already committed so it cannot be a real 404.
        const unknown = err instanceof Error && err.name === "UnknownConversationError";
        // eslint-disable-next-line no-console
        withConversation(sessionId, () =>
          log.errorWith("prompt failed; surfacing RUN_ERROR to the client", err, {
            unknown_conversation: unknown,
          }),
        );
        if (unknown) {
          try {
            write(res, {
              type: "RUN_ERROR",
              message: `No such conversation: ${sessionId}. Create one first (POST /conversations) and prompt the id it returns.`,
              // Webhooks start a replacement conversation only on this code (issue #802).
              code: "UNKNOWN_CONVERSATION",
            });
          } catch {
            /* stream already torn down */
          }
          res.end();
          return;
        }
        try {
          write(res, { type: "RUN_ERROR", message: `The agent could not start this run: ${message}` });
        } catch {
          /* stream already torn down */
        }
        res.end();
      }
      return;
    }

    // The legacy /sessions/:id/* routes below are gated like /agui.
    if (parts[0] === "sessions" && parts[1] && (await refuseHidden(req, res, decodeURIComponent(parts[1])))) return;

    // GET /sessions/:id/events is the SSE subscription.
    if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "events") {
      const sessionId = parts[1];
      res.writeHead(200, {
        "Content-Type": encoder.getContentType(),
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      let set = connections.get(sessionId);
      if (!set) connections.set(sessionId, (set = new Set()));
      set.add(res);
      req.on("close", () => set!.delete(res));

      const conn: AguiConnection = {
        sessionId,
        send: (e) => write(res, e),
        close: () => res.end(),
      };
      await attachHandler?.(sessionId, conn); // replay the event log
      return;
    }

    // POST /sessions/:id/prompt
    if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "prompt") {
      const body = JSON.parse((await readBody(req)) || "{}") as RunAgentInput;
      await promptHandler?.(parts[1], body);
      res.writeHead(202).end();
      return;
    }

    // The web-service reverse proxy (/c/<id>/<service>/...) goes last so it never shadows the API routes.
    if (mountedProxy && mountedProxy.matches(url.pathname)) {
      await mountedProxy.handleHttp(req, res);
      return;
    }

    res.writeHead(404).end();
  };

  return {
    listen(port) {
      return new Promise((resolve) => {
        server = createServer((req, res) => {
          handle(req, res).catch((err) => {
            // Last-resort catch for a route that throws: log the real error and answer with
            // a generic JSON envelope, never the raw error string.
            log.errorWith("unhandled route error", err, {
              http_method: req.method,
              url: req.url,
            });
            if (!res.headersSent && isDbUnavailable(err)) {
              // A database outage is transient; tell the caller to retry rather than fail.
              res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
              res.end(JSON.stringify({ error: "database unavailable" }));
            } else if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "internal error" }));
            } else {
              res.end(); // headers already sent (e.g. mid-SSE)
            }
          });
        });
        server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
        server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;
        // WebSocket upgrades for registered handlers and proxied services.
        server.on("upgrade", (req, socket, head) => {
          const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
          const registered = upgradeHandlers.get(pathname);
          if (registered && sandboxLabelOf(req) === undefined) {
            registered(req, socket, head);
          } else if (mountedProxy && mountedProxy.matches(pathname)) {
            mountedProxy.handleUpgrade(req, socket, head).catch(() => socket.destroy());
          } else {
            socket.destroy();
          }
        });
        server.listen(port, () => resolve());
      });
    },
    port() {
      const addr = server?.address();
      return addr && typeof addr === "object" ? addr.port : undefined;
    },
    close() {
      return new Promise((resolve) => {
        for (const set of connections.values()) for (const res of set) res.end();
        connections.clear();
        server?.close(() => resolve());
      });
    },
    onPrompt(handler) {
      // Bind the conversation id once here so everything the handler touches logs it
      // without taking it as a parameter; a throw still propagates to the caller's catch.
      promptHandler = (sessionId, input) =>
        withConversation(sessionId, () => handler(sessionId, input));
    },
    onResume(handler) {
      resumeHandler = handler;
    },
    broadcast,
    onAttach(handler) {
      attachHandler = handler;
    },
    use(router) {
      mountedRouter = router;
    },
    useAccessCheck(check) {
      accessCheck = check;
    },
    useOwnerVerifier(verify) {
      ownerVerifier = verify;
    },
    useIdentityResolver(resolve) {
      identityResolver = resolve;
    },
    onUpgrade(pathname, handler) {
      upgradeHandlers.set(pathname, handler);
    },
    useProxy(proxy) {
      mountedProxy = proxy;
    },
    subscribeSSE,
  };
}
