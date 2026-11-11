/**
 * Structured logging for the agent-host: one JSON object per line on stdout/stderr
 * (`{"ts","level","service","component","msg",...fields}`), which the cluster's log
 * collector ingests directly. The conversation id is ambient via AsyncLocalStorage:
 * `withConversation(id, fn)` at an entry point stamps it on every line underneath,
 * including across awaits. A human tailing logs locally gets the pretty renderer
 * (LOG_FORMAT=pretty, the default outside a container).
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type Level = "debug" | "info" | "warn" | "error";

/** Fields duplicated onto every log line within a context, so keep it small. */
export interface LogContext {
  /** The conversation this work belongs to, the field that makes a cross-service trace possible. */
  conversation_id?: string;
  /** The run within that conversation, when there is one. */
  run_id?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/** Run `fn` with `ctx` attached to every log line it emits, including across awaits; nested calls merge. */
export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const merged = { ...(storage.getStore() ?? {}), ...ctx };
  return storage.run(merged, fn);
}

/** Convenience for the overwhelmingly common case. */
export function withConversation<T>(conversationId: string, fn: () => T): T {
  return withContext({ conversation_id: conversationId }, fn);
}

/** The active context, or an empty object. */
export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configuredLevel = (): Level => {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw in LEVELS) return raw as Level;
  // DEBUG=1 is honored as well as LOG_LEVEL.
  if (process.env.DEBUG === "1" || process.env.AGENT_HOST_DEBUG === "1") return "debug";
  return "info";
};

/** JSON in a pod (KUBERNETES_SERVICE_HOST is set), human-readable at a terminal. */
const jsonOutput = (): boolean => {
  const fmt = (process.env.LOG_FORMAT ?? "").toLowerCase();
  if (fmt === "json") return true;
  if (fmt === "pretty") return false;
  return process.env.KUBERNETES_SERVICE_HOST !== undefined;
};

const SERVICE = process.env.LOG_SERVICE ?? "agent-host";

let minLevel = LEVELS[configuredLevel()];
let asJson = jsonOutput();

/** Re-read the environment (for tests). */
export function reconfigureLogging(): void {
  minLevel = LEVELS[configuredLevel()];
  asJson = jsonOutput();
}

/** Serialize a caught value into something with actual content, since a WebSocket or k8s client error's useful fields are non-enumerable. */
// A thrown value as text; JSON-RPC errors aren't Errors.
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const { message, data } = err as { message?: unknown; data?: unknown };
    if (typeof message === "string" && message) {
      if (data === undefined || data === null) return message;
      return `${message}: ${typeof data === "string" ? data : JSON.stringify(data)}`;
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== "{}") return json;
    } catch {
      // Circular: described below.
    }
    // Opaque object: describe a wrapped error, else name its type.
    const inner = (err as { error?: unknown; cause?: unknown }).error ?? (err as { cause?: unknown }).cause;
    if (inner !== undefined && inner !== err) return errorText(inner);
    return `${err.constructor?.name ?? "object"} with no message`;
  }
  return String(err);
}

/** A thrown value's code (JSON-RPC, errno, k8s), if it has one. */
export function errorCode(err: unknown): string | number | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

export function formatError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = { message: err.message, name: err.name };
    if (err.stack) out.stack = err.stack;
    // k8s/http clients hang status codes off the error.
    for (const k of ["code", "statusCode", "status", "reason", "errno"]) {
      const v = (err as unknown as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    if (err.cause !== undefined) out.cause = formatError(err.cause);
    return out;
  }
  if (err && typeof err === "object") {
    // getOwnPropertyNames so non-enumerable fields survive.
    const own = Object.getOwnPropertyNames(err);
    if (own.length) {
      const out: Record<string, unknown> = {};
      for (const k of own) out[k] = (err as Record<string, unknown>)[k];
      return out;
    }
    // Genuinely empty (a WebSocket close event, say), so say so rather than emit `{}`.
    return { message: String(err), note: "thrown value has no own properties" };
  }
  return { message: String(err) };
}

type Fields = Record<string, unknown>;

function emit(level: Level, component: string, msg: string, fields: Fields = {}): void {
  if (LEVELS[level] < minLevel) return;

  const ctx = currentContext();
  const line: Fields = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    component,
    msg,
    ...ctx,
    ...fields,
  };

  // error/warn to stderr, the rest to stdout, so a collector can split them without parsing.
  const sink = level === "error" || level === "warn" ? console.error : console.log;

  if (asJson) {
    try {
      // eslint-disable-next-line no-console
      sink(JSON.stringify(line));
    } catch {
      // A circular value must not lose the line entirely, so rebuild from the known-safe
      // envelope and drop the caller's payload.
      // eslint-disable-next-line no-console
      sink(
        JSON.stringify({
          ts: line.ts,
          level: line.level,
          service: line.service,
          component: line.component,
          msg: line.msg,
          ...ctx,
          fields: "[unserializable]",
        }),
      );
    }
    return;
  }

  // Pretty: the `[component] message` shape, then the fields.
  const id = ctx.conversation_id ? ` conv=${ctx.conversation_id.slice(0, 8)}` : "";
  const extra = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" ");
  // eslint-disable-next-line no-console
  sink(`[${component}]${id} ${msg}${extra ? ` ${extra}` : ""}`);
}

/** A logger bound to one component, e.g. `logger("bridge").info("prompt queued", { queue_depth: 3 })`. */
export function logger(component: string) {
  return {
    debug: (msg: string, fields?: Fields) => emit("debug", component, msg, fields),
    info: (msg: string, fields?: Fields) => emit("info", component, msg, fields),
    warn: (msg: string, fields?: Fields) => emit("warn", component, msg, fields),
    error: (msg: string, fields?: Fields) => emit("error", component, msg, fields),
    /** An error line carrying `err` through formatError. */
    errorWith: (msg: string, err: unknown, fields?: Fields) =>
      emit("error", component, msg, { ...fields, error: formatError(err) }),
    /** Warn the first time `key` is seen and debug after, until `forgetWarned` re-arms it. */
    warnOnce: (key: string, msg: string, fields?: Fields) => {
      const repeat = warned.has(key);
      warned.add(key);
      emit(repeat ? "debug" : "warn", component, msg, repeat ? { ...fields, repeat_suppressed: true } : fields);
    },
  };
}

const warned = new Set<string>();

/** Re-arm `warnOnce` for keys not in `keep` (or every key when omitted), so a condition that clears and returns is loud again. */
export function forgetWarned(keep?: Set<string>): void {
  if (!keep) return void warned.clear();
  for (const k of warned) if (!keep.has(k)) warned.delete(k);
}

export type Logger = ReturnType<typeof logger>;

/** "fetch failed <- connect ECONNREFUSED (ECONNREFUSED)": each cause, readable. */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = err; e !== undefined && parts.length < 4; e = (e as { cause?: unknown }).cause) {
    if (!(e instanceof Error)) {
      parts.push(String(e));
      break;
    }
    const code = (e as { code?: unknown }).code;
    parts.push(code ? `${e.message} (${String(code)})` : e.message);
  }
  return parts.join(" <- ");
}
