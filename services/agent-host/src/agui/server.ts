/**
 * AG-UI server — streams AG-UI events from the agent-host to the browser.
 *
 * Transport: Server-Sent Events (SSE). AG-UI's event stream is one-directional
 * (agent -> UI), so SSE fits; prompts/permission answers come over POST.
 * assistant-ui's native AG-UI runtime consumes the SSE stream.
 *
 * Events are encoded with @ag-ui/encoder so the wire format is the canonical
 * AG-UI SSE framing.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";

import { EventEncoder } from "@ag-ui/encoder";
import type { BaseEvent } from "@ag-ui/core";

import type { AguiEvent } from "../bridge.js";
import type { SessionId, ThreadId } from "../types.js";
import type { Router } from "../http/router.js";
import type { WebServiceProxy } from "../proxy/webServiceProxy.js";
import { logger, withConversation } from "../log.js";

const log = logger("agui");

/** Defensive guard for the /agui RESUME branch: after answering, the resumed run's
 *  events stream back over the SSE. If NOTHING streams within this window (any silent-
 *  hang cause), close the stream with a RUN_ERROR instead of relying on a proxy to kill
 *  an idle upstream. Must comfortably exceed a legitimately-slow resume (a revive can
 *  re-spawn goose + replay history), so it's generous — it only fires on a true hang.
 *  Read per-branch (not at module load) so it's overridable via SCOOTER_RESUME_GUARD_MS,
 *  including in tests. */
const resumeStreamGuardMs = (): number => Number(process.env.SCOOTER_RESUME_GUARD_MS ?? 60_000);

/** A raw inbound image on a user message (base64 bytes + mime) — before it's
 *  stored in the AssetStore. The promptHandler (index.ts) stores it and passes the
 *  resulting assetId to the bridge. */
export interface InboundImage {
  data: string; // base64
  mimeType: string;
}

/** A NON-image attachment (Slack binary: pdf/zip/docx/…). The bytes ride base64;
 *  the agent-host materializes it into the sandbox at /workspace/.slack/<name>. */
export interface InboundFile {
  name: string;
  data: string; // base64
  mimeType: string;
}

/** One part of a multimodal message content array. Text, image, or file; other
 *  AG-UI part shapes are tolerated (ignored). */
export type ContentPart =
  | { type: "text"; text?: string }
  | { type: "image"; data?: string; mimeType?: string; image?: string; [k: string]: unknown }
  | { type: "file"; name?: string; data?: string; mimeType?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** Normalize a message's `content` (string | ContentPart[]) into prompt text +
 *  inbound images + inbound files. A plain string is the text (no attachments) —
 *  the unchanged path. */
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
      // Accept {data, mimeType} (our shape) or {image} (assistant-ui data URL).
      const p = part as { data?: string; mimeType?: string; image?: string };
      const parsed = p.data && p.mimeType
        ? { data: p.data, mimeType: p.mimeType }
        : p.image
          ? parseDataUrl(p.image)
          : null;
      if (parsed) images.push(parsed);
    } else if (part.type === "file") {
      // A binary attachment (Slack pdf/zip/…): {name, data(base64), mimeType}.
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
  /** Per-conversation model pick/switch (from the X-Agent-Model header on the
   *  /agui POST). Undefined = keep the conversation's current model. */
  model?: string;
  /** Priority tier (PRIORITY_INTERRUPT) for a force-interrupting message — a
   *  webhooks `@scooter` mention to an ACTIVE conversation sets this so it can
   *  preempt a stuck turn after the bridge's priority timeout. The UI (a human
   *  typing) never sets it. Undefined/0 = normal (waits its turn). */
  priority?: number;
  /** The Scooter user id to OWN a webhook-spawned conversation (the external-user
   *  identity mapping resolved this). SECURITY: honored ONLY when the caller is the
   *  TRUSTED webhooks service, verified by its ServiceAccount token via k8s
   *  TokenReview (see auth/webhooksCaller.ts) — a browser / any other caller can't
   *  claim a conversation. Undefined = no owner set here (the UI path stamps the
   *  ingress identity on POST /conversations instead). */
  owner?: string;
  /** Images attached to the latest user message (base64), from a multimodal
   *  content array. Empty/undefined = a text-only message (the unchanged path). */
  images?: InboundImage[];
  /** Binary file attachments (Slack pdf/zip/…) on the latest user message (base64).
   *  The agent-host materializes each into the sandbox at /workspace/.slack/<name>.
   *  Empty/undefined = no file attachments (the unchanged path). */
  files?: InboundFile[];
  /** SYSTEM message source — set when a PLATFORM caller (webhooks, scheduler) injects
   *  a message that isn't a human turn. Tags it so the agent gets a "system event"
   *  decoration and the UI can hide it. Undefined = a human message. Trusted like
   *  `owner`: only meaningful from the webhooks/scheduler SA, but harmless if spoofed
   *  (it just makes a message render as system, no privilege). */
  source?: string;
}

/** One connected UI client subscribed to a session's event stream. */
export interface AguiConnection {
  readonly sessionId: SessionId;
  send(event: AguiEvent): void;
  close(): void;
}

/** The result of handling one resume entry. `ok:false` (with an optional human reason)
 *  tells the /agui resume branch to close the SSE with a RUN_ERROR rather than leave it
 *  open with no data — the difference between a rendered failure and a silent hang/502. */
export interface ResumeOutcome {
  ok: boolean;
  reason?: string;
}

export interface AguiServer {
  listen(port: number): Promise<void>;
  /** The bound port after listen() (for tests binding to :0). undefined if not listening. */
  port(): number | undefined;
  close(): Promise<void>;
  onPrompt(handler: (sessionId: SessionId, input: RunAgentInput) => Promise<void>): void;
  /** Answer a pending permission request (toolCallId -> optionId). */
  onPermission(handler: (sessionId: SessionId, toolCallId: string, optionId: string) => Promise<void>): void;
  /** Resume a paused run: the user answered an interrupt via RunAgentInput.resume.
   *  status "cancelled" -> the request is cancelled; otherwise payload carries the
   *  chosen optionId. Returns whether the answer was routed: `ok:false` means the run
   *  isn't (and couldn't be revived into) a state that can accept this answer, so the
   *  resume branch closes the SSE with a RUN_ERROR instead of leaving it open + silent. */
  onResume(
    handler: (
      sessionId: SessionId,
      entry: { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown },
    ) => Promise<ResumeOutcome>,
  ): void;
  broadcast(sessionId: SessionId, event: AguiEvent): void;
  /** Replay the persisted event log to a newly-attached connection. */
  onAttach(handler: (sessionId: SessionId, conn: AguiConnection) => Promise<void>): void;
  /** Mount a management router; tried before the built-in AG-UI routes. */
  use(router: Router): void;
  /** Mount the web-service reverse proxy (/c/<id>/<service>/...): consulted as an
   *  HTTP fallback before the 404, and wired to the server's `upgrade` event for
   *  WebSocket services (marimo/xterm/vscode). */
  useProxy(proxy: WebServiceProxy): void;
  /** Register a raw WebSocket upgrade handler for an exact pathname (e.g.
   *  /remote-agent/connect for bring-your-own-Claude). Consulted on `upgrade` BEFORE the
   *  proxy; the handler owns the socket (auth + protocol). Generic — the server needs no
   *  knowledge of what it connects. */
  onUpgrade(pathname: string, handler: (req: import("node:http").IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void): void;
  /** Set the verifier that decides whether a /agui request is the TRUSTED webhooks
   *  caller (its SA token via TokenReview) — gating the privileged `owner` field.
   *  Absent = owner is never honored. */
  useOwnerVerifier(verify: (req: import("node:http").IncomingMessage) => Promise<boolean>): void;
  /** Resolve the caller's ingress identity so a UI-created conversation (POST /agui)
   *  is OWNED by the human who created it. Without this, a browser-created
   *  conversation gets no owner (the Mine/All filter can't see it as yours). Absent =
   *  no owner stamped from /agui (single-user / no-FGA deployments). */
  useIdentityResolver(resolve: (req: import("node:http").IncomingMessage) => { id: string; anonymous: boolean } | Promise<{ id: string; anonymous: boolean }>): void;
  /** Attach an SSE response to a session's persistent event stream (for the
   *  management API's GET .../events). Returns once replay (onAttach) is done. */
  subscribeSSE(sessionId: SessionId, res: ServerResponse): Promise<void>;
}

/** Our internal AguiEvent IS a BaseEvent once `type` is the discriminator. */
function toBaseEvent(event: AguiEvent): BaseEvent {
  return event as unknown as BaseEvent;
}

export function createAguiServer(): AguiServer {
  const encoder = new EventEncoder();
  const connections = new Map<SessionId, Set<ServerResponse>>();

  let promptHandler:
    | ((sessionId: SessionId, input: RunAgentInput) => Promise<void>)
    | undefined;
  let permissionHandler:
    | ((sessionId: SessionId, toolCallId: string, optionId: string) => Promise<void>)
    | undefined;
  let resumeHandler:
    | ((
        sessionId: SessionId,
        entry: { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown },
      ) => Promise<ResumeOutcome>)
    | undefined;
  let attachHandler:
    | ((sessionId: SessionId, conn: AguiConnection) => Promise<void>)
    | undefined;

  let server: Server | undefined;
  let mountedRouter: Router | undefined;
  let mountedProxy: WebServiceProxy | undefined;
  // Exact-pathname WS upgrade handlers (bring-your-own-Claude /remote-agent/connect, etc.),
  // consulted before the proxy on `upgrade`.
  const upgradeHandlers = new Map<string, (req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => void>();
  let ownerVerifier: ((req: IncomingMessage) => Promise<boolean>) | undefined;
  let identityResolver: ((req: IncomingMessage) => { id: string; anonymous: boolean } | Promise<{ id: string; anonymous: boolean }>) | undefined;

  const write = (res: ServerResponse, event: AguiEvent) => {
    res.write(encoder.encodeSSE(toBaseEvent(event)));
  };

  const subscribeSSE = async (sessionId: SessionId, res: ServerResponse): Promise<void> => {
    res.writeHead(200, {
      "Content-Type": encoder.getContentType(),
      "Cache-Control": "no-cache",
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

  // Connections opened via POST /agui are run-scoped: they close when the run
  // ends. The persistent GET /sessions/:id/events connections stay open.
  const runScoped = new WeakSet<ServerResponse>();

  // Broadcast a run's live AG-UI events ONLY to run-scoped connections — i.e.
  // the POST /agui stream of the client that started THIS run. We deliberately
  // do NOT push to persistent (GET .../events) connections: a run the client
  // didn't initiate (driven by another tab or a webhook via POST
  // /conversations/:id/messages) would otherwise reach an idle @ag-ui client as
  // a stray RUN_STARTED — which it rejects ("RUN_STARTED while a run is still
  // active"). The open UI renders those external runs through the separate
  // integrity stream (GET .../events.integrity) instead, which is fed off the
  // persist path and carries every event with its checksum. The right primitive
  // for each: run-scoped SSE for your own run, the integrity stream for the rest.
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

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);

    // Management API (mounted router) is tried first.
    if (mountedRouter && (await mountedRouter.handle(req, res))) return;

    // GET /healthz  -> readiness probe
    if (req.method === "GET" && parts[0] === "healthz") {
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"status":"ok"}');
      return;
    }

    // POST /agui  -> the standard AG-UI HttpAgent protocol: accept a
    // RunAgentInput and stream this run's AG-UI events back over SSE. This is
    // what @ag-ui/client HttpAgent (used by assistant-ui) talks to.
    if (req.method === "POST" && parts[0] === "agui") {
      const input = JSON.parse((await readBody(req)) || "{}") as {
        threadId: string;
        runId?: string;
        // content is a plain string (text-only, the common case) OR an array of
        // content parts (multimodal: text + image parts).
        messages?: Array<{ role: string; content?: string | ContentPart[] }>;
        /** Priority tier for a force-interrupting message (webhooks @mention). */
        priority?: number;
        /** The Scooter user to OWN a webhook-spawned conversation. Honored ONLY for
         *  a TokenReview-verified webhooks caller (ownerVerifier); ignored otherwise. */
        owner?: string;
        /** Per-interrupt responses (assistant-ui resumes a paused run with these
         *  instead of a new user message). */
        resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>;
        /** SYSTEM message source (webhooks/scheduler) — renders as a hideable system
         *  message + decorates the agent prompt. Absent = a human message. */
        source?: string;
      };
      const sessionId = input.threadId;
      res.writeHead(200, {
        "Content-Type": encoder.getContentType(),
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Subscribe this response to the session's events for the duration of the
      // run; unsubscribe when the run completes.
      let set = connections.get(sessionId);
      if (!set) connections.set(sessionId, (set = new Set()));
      set.add(res);
      runScoped.add(res);
      req.on("close", () => set!.delete(res));

      // A RESUME (answer to a pending interrupt) reconnects to the still-blocked
      // run and unpauses it — its continued events stream back over THIS SSE. We
      // do NOT start a new prompt for a resume.
      if (input.resume && input.resume.length > 0) {
        // The handler REVIVES the run if needed, then answers; it reports whether the
        // answer was actually routed. If ANY entry can't be answered (dormant/expired
        // interrupt with nothing to revive into), close with a RUN_ERROR instead of
        // leaving the stream open + silent — the reported hang/502
        // (docs/scooter-bug-resume-hangs-when-run-not-live.md). When answered, the run
        // resumes and streams its continued events over THIS res (via broadcast), which
        // terminal-closes it as usual.
        const outcomes = await Promise.all(
          input.resume.map((r) => resumeHandler?.(sessionId, r) ?? Promise.resolve({ ok: true } as ResumeOutcome)),
        );
        const failed = outcomes.find((o) => o && !o.ok);
        if (failed) {
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
        // Answered — keep the stream open for the resumed run's continued events, but
        // GUARD against a silent hang from ANY other cause: if this res is still open
        // and has streamed nothing by the deadline, close it with a RUN_ERROR rather
        // than relying on a proxy to kill an idle upstream. broadcast() removes res from
        // `set` + res.end()s it on the run's terminal event, so "still in set and
        // writable" == "the resumed run never produced anything".
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

      // The latest user message is the prompt. Its content is either a plain
      // string (text-only) or an array of parts (multimodal); normalize to text +
      // inbound images.
      const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
      const { text, images, files } = normalizeContent(lastUser?.content);
      // The UI rides the per-conversation model on a header (the assistant-ui
      // runtime drives the AG-UI body, so a header is the clean injection point).
      const hdr = req.headers["x-agent-model"];
      const model = (Array.isArray(hdr) ? hdr[0] : hdr) || undefined;
      // Resolve the conversation OWNER, stamped on first creation so the Mine/All
      // filter attributes a UI-created conversation to the human who made it.
      //   1. PRIVILEGED webhooks path: an explicit `input.owner` (a Scooter user the
      //      webhooks service resolved), honored ONLY when the caller is the TRUSTED
      //      webhooks SA (TokenReview via ownerVerifier) — not a header the ingress
      //      is trusted to strip. A browser can't set this.
      //   2. NORMAL UI path: the browser doesn't send `owner`; instead we resolve the
      //      caller's INGRESS IDENTITY here (the same resolver /whoami + POST
      //      /conversations use) and own the conversation to that user. Anonymous
      //      (no identity / FGA-off / dev) → no owner, preserving single-user mode.
      let owner: string | undefined;
      if (input.owner && ownerVerifier && (await ownerVerifier(req).catch(() => false))) {
        owner = input.owner;
      } else if (identityResolver) {
        const user = await Promise.resolve(identityResolver(req)).catch(() => undefined);
        if (user && !user.anonymous) owner = user.id;
      }
      // Drive the run. If promptHandler THROWS before the run ever emits a terminal
      // event (the big one: revive/provision fails — e.g. 409 AlreadyExists from a
      // wrong hydrate map, goose spawn/ACP-connect error), the SSE 200 header is
      // ALREADY sent, so the outer handle().catch can't send a 500 — it would just
      // res.end() a raw error string that assistant-ui can't parse, and the UI hangs
      // with NO error (the hydrate-silent-drop bug). Emit a proper RUN_ERROR event on
      // THIS stream + close it, so the UI has something to render as a failed send.
      try {
        await promptHandler?.(sessionId, { threadId: sessionId, text, model, priority: input.priority, owner, images, files, source: input.source });
        // promptHandler drives the run; RUN_FINISHED/RUN_ERROR close the stream.
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The caller prompted an id that does not exist — a caller bug, not a run
        // failure. The 200 + SSE head is already committed here, so this cannot be a
        // real 404; give the caller an actionable message instead.
        const unknown = err instanceof Error && err.name === "UnknownConversationError";
        // eslint-disable-next-line no-console
        withConversation(sessionId, () =>
          log.errorWith("prompt failed; surfacing RUN_ERROR to the client", err, {
            // Distinguishes "the caller asked for a conversation that does not exist" from
            // "the run itself blew up", without parsing the message.
            unknown_conversation: unknown,
          }),
        );
        if (unknown) {
          try {
            write(res, {
              type: "RUN_ERROR",
              message: `No such conversation: ${sessionId}. Create one first (POST /conversations) and prompt the id it returns.`,
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

    // GET /sessions/:id/events  -> SSE subscription
    if (req.method === "GET" && parts[0] === "sessions" && parts[2] === "events") {
      const sessionId = parts[1];
      res.writeHead(200, {
        "Content-Type": encoder.getContentType(),
        "Cache-Control": "no-cache",
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

    // POST /sessions/:id/permission/:toolCallId  { optionId }
    if (req.method === "POST" && parts[0] === "sessions" && parts[2] === "permission") {
      const body = JSON.parse((await readBody(req)) || "{}") as { optionId: string };
      await permissionHandler?.(parts[1], parts[3], body.optionId);
      res.writeHead(204).end();
      return;
    }

    // Web-service reverse proxy (/c/<id>/<service>/...) — last, so it never
    // shadows the API routes above.
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
            // LAST-RESORT catch — a route that throws instead of returning an error result.
            // Log the real error here; the RESPONSE gets a generic JSON envelope, never
            // `String(err)`: raw error strings have no content-type (JSON-expecting clients
            // render parser artifacts instead of a message) and can carry internals into
            // something that gets screenshotted and pasted into issues. Routes with an
            // expected failure mode should catch it themselves and answer specifically
            // (see /remote-agent/join-token) — landing here is a bug worth the log line.
            log.errorWith("unhandled route error", err, {
              http_method: req.method,
              url: req.url,
            });
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "internal error" }));
            } else {
              res.end(); // headers gone (e.g. mid-SSE) — just close; the log has the cause
            }
          });
        });
        // WebSocket upgrades for proxied services (marimo kernel, xterm PTY,
        // vscode RPC). The agent-host had no upgrade handler before this.
        server.on("upgrade", (req, socket, head) => {
          const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
          const registered = upgradeHandlers.get(pathname);
          if (registered) {
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
      // Bind the conversation id ONCE, here, rather than at each call site that invokes
      // promptHandler. Everything the handler touches — session manager, bridge, exec, the
      // k8s registry — then logs it without taking it as a parameter, which is the point:
      // those sites are frames deep and have no other reason to know it.
      // Wrapping the HANDLER (not its callers) keeps control flow identical: a throw still
      // propagates to the caller's catch, so the /agui error path is unchanged.
      promptHandler = (sessionId, input) =>
        withConversation(sessionId, () => handler(sessionId, input));
    },
    onPermission(handler) {
      permissionHandler = handler;
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
