/**
 * Structured logging for the agent-host.
 *
 * WHY. Today's lines are prose with values interpolated into them:
 *
 *   [conversationRegistry] failed to patch Conversation CR 42bb375c-…: Error: …
 *
 * Readable by a human tailing logs, useless to a tool. You cannot ask "show me everything
 * that happened to conversation 42bb375c" — which is the question worth asking, and the one
 * that has cost the most time. An audit of the tree found 153 TypeScript log sites, of
 * which only 11 mention a conversation id at all. See
 * todo/draft/STRUCTURED_LOGGING_AUDIT.md.
 *
 * THE SHAPE. One JSON object per line:
 *
 *   {"ts":"…","level":"info","service":"agent-host","component":"bridge",
 *    "msg":"prompt queued","conversation_id":"42bb375c-…"}
 *
 * `component` is the existing `[bracket]` prefix promoted to a field — 83% of call sites
 * already carry one, so the convention is being formalized, not replaced.
 *
 * HOW THE CONVERSATION ID GETS THERE. Ambient, via AsyncLocalStorage, not threaded through
 * every signature. A log site five frames deep inside a bridge or an exec has no business
 * taking a conversation id as a parameter just to log it, and retrofitting 153 call sites
 * that way would be a far larger and more invasive change. `withConversation(id, fn)` at
 * the entry points — the /agui handler, a management route, a bridge run — makes the id
 * ambient for everything underneath, including across awaits.
 *
 * OUTPUT. stdout/stderr, one line each. NOT the OTel SDK: this cluster's collector
 * (Alloy, via the k8s-monitoring chart) already scrapes pod logs into Loki, so stdout IS
 * the ingestion path and needs no new dependency or exporter. See the audit §7.
 *
 * DEV. A human tailing logs locally gets the pretty renderer instead (LOG_FORMAT=pretty,
 * the default when not in a container). JSON is for the collector, not for people.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export type Level = "debug" | "info" | "warn" | "error";

/** Fields that ride EVERY line within a context. Keep this small — it is duplicated onto
 *  every log line inside the scope. */
export interface LogContext {
  /** The conversation this work belongs to. The single highest-value field: it is what
   *  makes a cross-service (and, with browser telemetry, cross-tier) trace possible. */
  conversation_id?: string;
  /** The run within that conversation, when there is one. */
  run_id?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

/**
 * Run `fn` with `ctx` attached to every log line it emits, including after awaits and
 * inside callbacks it schedules. Nested calls MERGE, so an inner scope can add run_id
 * without restating conversation_id.
 */
export function withContext<T>(ctx: LogContext, fn: () => T): T {
  const merged = { ...(storage.getStore() ?? {}), ...ctx };
  return storage.run(merged, fn);
}

/** Convenience for the overwhelmingly common case. */
export function withConversation<T>(conversationId: string, fn: () => T): T {
  return withContext({ conversation_id: conversationId }, fn);
}

/** The active context, or an empty object. Exported for tests and for the rare caller that
 *  needs to forward the id somewhere non-logging (e.g. onto an outbound header). */
export function currentContext(): LogContext {
  return storage.getStore() ?? {};
}

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configuredLevel = (): Level => {
  const raw = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (raw in LEVELS) return raw as Level;
  // DEBUG=1 kept working: it is what the existing debug() honored, and turning it off
  // silently during this migration would lose traces people rely on.
  if (process.env.DEBUG === "1" || process.env.AGENT_HOST_DEBUG === "1") return "debug";
  return "info";
};

/** JSON in a container, human-readable at a terminal. KUBERNETES_SERVICE_HOST is set by
 *  k8s in every pod, so this picks the right default without configuration. */
const jsonOutput = (): boolean => {
  const fmt = (process.env.LOG_FORMAT ?? "").toLowerCase();
  if (fmt === "json") return true;
  if (fmt === "pretty") return false;
  return process.env.KUBERNETES_SERVICE_HOST !== undefined;
};

const SERVICE = process.env.LOG_SERVICE ?? "agent-host";

let minLevel = LEVELS[configuredLevel()];
let asJson = jsonOutput();

/** Re-read the environment. Tests use this; production reads it once at import. */
export function reconfigureLogging(): void {
  minLevel = LEVELS[configuredLevel()];
  asJson = jsonOutput();
}

/**
 * Serialize a caught value into something with actual content.
 *
 * A raw `console.error("...", err)` renders a WebSocket or k8s client error as `{}`,
 * because their useful fields are non-enumerable — the audit found 35 call sites with that
 * shape, and two of them produced literally unattributable failures in production. Errors
 * go through here instead.
 */
export function formatError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const out: Record<string, unknown> = { message: err.message, name: err.name };
    if (err.stack) out.stack = err.stack;
    // k8s/http clients hang status codes off the error; keep whatever is there.
    for (const k of ["code", "statusCode", "status", "reason", "errno"]) {
      const v = (err as unknown as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    if (err.cause !== undefined) out.cause = formatError(err.cause);
    return out;
  }
  if (err && typeof err === "object") {
    // getOwnPropertyNames (not JSON.stringify) so NON-ENUMERABLE fields survive — that is
    // the whole difference between a useful line and `{}`.
    const own = Object.getOwnPropertyNames(err);
    if (own.length) {
      const out: Record<string, unknown> = {};
      for (const k of own) out[k] = (err as Record<string, unknown>)[k];
      return out;
    }
    // Genuinely empty (a WebSocket close event, say). Say so, rather than emitting `{}`
    // and leaving the reader to wonder whether serialization failed.
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

  // error/warn to stderr, the rest to stdout — so a collector (or a human) can split them
  // without parsing, and a crashing pod's last words land where they are looked for.
  const sink = level === "error" || level === "warn" ? console.error : console.log;

  if (asJson) {
    try {
      // eslint-disable-next-line no-console
      sink(JSON.stringify(line));
    } catch {
      // A circular value must not lose the line entirely. Rebuild from the fields that are
      // known-safe (the envelope + context) and drop the caller's payload — spreading
      // `line` again here would re-include the value that just failed.
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

  // Pretty: keep the familiar `[component] message` shape, then the fields that matter.
  const id = ctx.conversation_id ? ` conv=${ctx.conversation_id.slice(0, 8)}` : "";
  const extra = Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" ");
  // eslint-disable-next-line no-console
  sink(`[${component}]${id} ${msg}${extra ? ` ${extra}` : ""}`);
}

/**
 * A logger bound to one component — the `[bracket]` prefix, now a queryable field.
 *
 *   const log = logger("bridge");
 *   log.info("prompt queued", { queue_depth: 3 });
 *   log.error("exec failed", { error: formatError(err) });
 */
export function logger(component: string) {
  return {
    debug: (msg: string, fields?: Fields) => emit("debug", component, msg, fields),
    info: (msg: string, fields?: Fields) => emit("info", component, msg, fields),
    warn: (msg: string, fields?: Fields) => emit("warn", component, msg, fields),
    error: (msg: string, fields?: Fields) => emit("error", component, msg, fields),
    /** Shorthand for the shape that was silently producing `{}`. */
    errorWith: (msg: string, err: unknown, fields?: Fields) =>
      emit("error", component, msg, { ...fields, error: formatError(err) }),
    /** warn the first time `key` is seen, debug after. For a condition re-detected
     *  every sweep: loud once per resource, never a flood. `forgetWarned` re-arms it. */
    warnOnce: (key: string, msg: string, fields?: Fields) => {
      const repeat = warned.has(key);
      warned.add(key);
      emit(repeat ? "debug" : "warn", component, msg, repeat ? { ...fields, repeat_suppressed: true } : fields);
    },
  };
}

const warned = new Set<string>();

/** Re-arm `warnOnce` for keys no longer active, so a condition that clears and returns is
 *  loud again. No argument forgets everything (tests). */
export function forgetWarned(keep?: Set<string>): void {
  if (!keep) return void warned.clear();
  for (const k of warned) if (!keep.has(k)) warned.delete(k);
}

export type Logger = ReturnType<typeof logger>;
