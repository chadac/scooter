/**
 * The marimo control protocol, as spoken by a running `marimo edit --no-token`
 * server. Verified against marimo-team/marimo-pair's execute-code.sh + the marimo
 * source (server_registry.py, /api/sessions, /api/kernel/execute).
 *
 * Two endpoints:
 *   GET  {base}/api/sessions          -> { "<sessionId>": SessionInfo, ... }
 *   POST {base}/api/kernel/execute    -> an SSE stream (see ExecuteEvent), with the
 *        header `Marimo-Session-Id: <id>` and body `{ code }`.
 *
 * The execute endpoint is the STABLE workhorse (scratchpad execution). Structural
 * cell ops (create/edit/run a named cell) run marimo's `marimo._code_mode` INSIDE
 * the kernel — i.e. we execute a code snippet that drives `cm.get_context()`. That
 * surface shipped in marimo v0.21.1 and is explicitly a moving target (marimo issue
 * #4345 is open), so it's isolated here and pinned to MARIMO_MIN_VERSION.
 */

/** marimo shipped the `marimo._code_mode` cell API in this release; the cell tools
 *  require at least this. (The scratchpad execute endpoint predates it.) */
export const MARIMO_MIN_CODE_MODE_VERSION = "0.21.1";

/** One entry in `GET /api/sessions` — keyed by session id in the response object. */
export interface SessionInfo {
  /** The notebook file's path (stable across browser reconnects) — used to target a
   *  specific session when several are open. */
  path?: string;
  filename?: string;
}

/** The parsed result of a scratchpad execution (folded from the SSE stream). */
export interface ExecuteResult {
  /** True unless the `done` frame reported `success: false` (a Python error). */
  success: boolean;
  /** Concatenated `event: stdout` data. */
  stdout: string;
  /** Concatenated `event: stderr` data (Python tracebacks land here). */
  stderr: string;
  /** The `done` frame's `output.data` — the value/representation of the last expr. */
  output: string;
}

/** Marimo's SSE frames on the execute stream (internal; parsed into ExecuteResult). */
export type ExecuteEvent =
  | { event: "stdout"; data: string }
  | { event: "stderr"; data: string }
  | { event: "done"; success: boolean; output: string };

/** How the client reaches ONE marimo server: base URL + optional bearer token.
 *  In-pod marimo runs token-less (`--no-token`), so `token` is usually undefined;
 *  it's here for a token-guarded server (MARIMO_TOKEN) for parity with marimo-pair. */
export interface MarimoTarget {
  /** e.g. `http://10.1.2.3:2718` — the pod IP + marimo port, no trailing slash. */
  baseUrl: string;
  token?: string;
}

/** Thrown for a protocol-level failure (non-200, stream ended without `done`, no
 *  session to target). Carries a machine-readable `kind` for the tool layer. */
export class MarimoError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "no-session"
      | "multiple-sessions"
      | "http-error"
      | "incomplete-stream"
      | "unreachable",
  ) {
    super(message);
    this.name = "MarimoError";
  }
}
