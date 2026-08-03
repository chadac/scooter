/**
 * A thin HTTP client for one running `marimo edit --no-token` server. Talks the two
 * endpoints in types.ts over node:http (the same transport the web-service proxy
 * uses to reach a pod). All fragile marimo-protocol knowledge lives here + sse.ts.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { MarimoError, type ExecuteResult, type MarimoTarget, type SessionInfo } from "./types.js";
import { parseSseEvents, foldExecute } from "./sse.js";

interface RawResponse {
  status: number;
  body: string;
}

/** One POST/GET to the marimo server, buffering the full body. Rejects (kind
 *  "unreachable") on a socket error/timeout — the pod may be asleep or still coming
 *  up. Kept tiny + injectable-free; tests drive a real http.Server. */
function httpCall(
  target: MarimoTarget,
  method: "GET" | "POST",
  path: string,
  opts: { sessionId?: string; body?: string; timeoutMs?: number } = {},
): Promise<RawResponse> {
  const url = new URL(target.baseUrl.replace(/\/$/, "") + path);
  const isHttps = url.protocol === "https:";
  const req = (isHttps ? httpsRequest : httpRequest);
  const headers: Record<string, string> = { accept: "text/event-stream, application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.sessionId) headers["Marimo-Session-Id"] = opts.sessionId;
  if (target.token) headers["authorization"] = `Bearer ${target.token}`;

  return new Promise<RawResponse>((resolve, reject) => {
    const r = req(
      {
        host: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on("error", (e) => reject(new MarimoError(`marimo unreachable: ${e.message}`, "unreachable")));
    r.setTimeout(opts.timeoutMs ?? 30_000, () => {
      r.destroy();
      reject(new MarimoError("marimo request timed out", "unreachable"));
    });
    if (opts.body !== undefined) r.write(opts.body);
    r.end();
  });
}

export interface MarimoClient {
  /** GET /api/sessions — the id→info map of open notebooks on this server. */
  listSessions(): Promise<Record<string, SessionInfo>>;
  /** Resolve the session to target: an explicit id, else the one open session, else
   *  match `file` against a session's path/filename. Throws (no-session /
   *  multiple-sessions) when it can't pick exactly one. */
  resolveSession(opts?: { sessionId?: string; file?: string }): Promise<string>;
  /** POST /api/kernel/execute — run `code` in the resolved session's scratchpad and
   *  fold the SSE stream into a result. Throws on non-200 / an incomplete stream. */
  execute(code: string, opts?: { sessionId?: string; file?: string }): Promise<ExecuteResult>;
}

export function createMarimoClient(target: MarimoTarget): MarimoClient {
  async function listSessions(): Promise<Record<string, SessionInfo>> {
    const res = await httpCall(target, "GET", "/api/sessions");
    if (res.status !== 200) {
      throw new MarimoError(`GET /api/sessions -> HTTP ${res.status}`, "http-error");
    }
    try {
      const data = JSON.parse(res.body) as Record<string, SessionInfo>;
      return data && typeof data === "object" ? data : {};
    } catch {
      return {};
    }
  }

  async function resolveSession(opts: { sessionId?: string; file?: string } = {}): Promise<string> {
    if (opts.sessionId) return opts.sessionId;
    const sessions = await listSessions();
    const ids = Object.keys(sessions);
    if (opts.file) {
      const matches = ids.filter(
        (id) => sessions[id]?.path === opts.file || sessions[id]?.filename === opts.file,
      );
      if (matches.length === 1) return matches[0];
      if (matches.length === 0) {
        throw new MarimoError(`no open marimo session matches file "${opts.file}"`, "no-session");
      }
      throw new MarimoError(`multiple marimo sessions match file "${opts.file}"`, "multiple-sessions");
    }
    if (ids.length === 1) return ids[0];
    if (ids.length === 0) {
      throw new MarimoError("no marimo notebook is open (start one, then open it)", "no-session");
    }
    throw new MarimoError(
      `multiple marimo notebooks are open — target one by file: ${ids
        .map((id) => sessions[id]?.path ?? sessions[id]?.filename ?? id)
        .join(", ")}`,
      "multiple-sessions",
    );
  }

  async function execute(
    code: string,
    opts: { sessionId?: string; file?: string } = {},
  ): Promise<ExecuteResult> {
    const sessionId = await resolveSession(opts);
    const res = await httpCall(target, "POST", "/api/kernel/execute", {
      sessionId,
      body: JSON.stringify({ code }),
    });
    if (res.status !== 200) {
      throw new MarimoError(`POST /api/kernel/execute -> HTTP ${res.status}: ${res.body.slice(0, 200)}`, "http-error");
    }
    const result = foldExecute(parseSseEvents(res.body));
    if (!result) {
      throw new MarimoError(
        "marimo ended the execute stream without a result (the session may have changed — retry)",
        "incomplete-stream",
      );
    }
    return result;
  }

  return { listSessions, resolveSession, execute };
}
