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

/** A user prompt arriving from the UI (AG-UI RunAgentInput, subset). */
export interface RunAgentInput {
  threadId: ThreadId;
  text: string;
}

/** One connected UI client subscribed to a session's event stream. */
export interface AguiConnection {
  readonly sessionId: SessionId;
  send(event: AguiEvent): void;
  close(): void;
}

export interface AguiServer {
  listen(port: number): Promise<void>;
  close(): Promise<void>;
  onPrompt(handler: (sessionId: SessionId, input: RunAgentInput) => Promise<void>): void;
  /** Answer a pending permission request (toolCallId -> optionId). */
  onPermission(handler: (sessionId: SessionId, toolCallId: string, optionId: string) => Promise<void>): void;
  /** Resume a paused run: the user answered an interrupt via RunAgentInput.resume.
   *  status "cancelled" -> the request is cancelled; otherwise payload carries the
   *  chosen optionId. */
  onResume(
    handler: (
      sessionId: SessionId,
      entry: { interruptId: string; status: "resolved" | "cancelled"; payload?: unknown },
    ) => Promise<void>,
  ): void;
  broadcast(sessionId: SessionId, event: AguiEvent): void;
  /** Replay the persisted event log to a newly-attached connection. */
  onAttach(handler: (sessionId: SessionId, conn: AguiConnection) => Promise<void>): void;
  /** Mount a management router; tried before the built-in AG-UI routes. */
  use(router: Router): void;
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
      ) => Promise<void>)
    | undefined;
  let attachHandler:
    | ((sessionId: SessionId, conn: AguiConnection) => Promise<void>)
    | undefined;

  let server: Server | undefined;
  let mountedRouter: Router | undefined;

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

  const broadcast = (sessionId: SessionId, event: AguiEvent) => {
    const set = connections.get(sessionId);
    if (!set) return;
    const terminal = event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";
    for (const res of set) {
      write(res, event);
      if (terminal && runScoped.has(res)) {
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
        messages?: Array<{ role: string; content?: string }>;
        /** Per-interrupt responses (assistant-ui resumes a paused run with these
         *  instead of a new user message). */
        resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>;
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
        for (const r of input.resume) await resumeHandler?.(sessionId, r);
        return;
      }

      // The latest user message is the prompt text.
      const lastUser = [...(input.messages ?? [])].reverse().find((m) => m.role === "user");
      const text = lastUser?.content ?? "";
      await promptHandler?.(sessionId, { threadId: sessionId, text });
      // promptHandler drives the run; RUN_FINISHED/RUN_ERROR close the stream.
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

    res.writeHead(404).end();
  };

  return {
    listen(port) {
      return new Promise((resolve) => {
        server = createServer((req, res) => {
          handle(req, res).catch((err) => {
            if (!res.headersSent) res.writeHead(500);
            res.end(String(err));
          });
        });
        server.listen(port, () => resolve());
      });
    },
    close() {
      return new Promise((resolve) => {
        for (const set of connections.values()) for (const res of set) res.end();
        connections.clear();
        server?.close(() => resolve());
      });
    },
    onPrompt(handler) {
      promptHandler = handler;
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
    subscribeSSE,
  };
}
