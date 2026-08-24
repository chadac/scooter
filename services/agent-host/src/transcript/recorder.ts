/**
 * Agent transcript recorder — captures the RAW messages crossing the agent
 * boundary (goose ACP frames / claude SDK query() messages) AND the bridge's
 * emitted AG-UI events, correlated by runId, so tests can REPLAY real behavior
 * instead of hand-authored fakes that diverge from reality.
 *
 *. Purpose: make the e2e/contract test
 * harness as real as possible WITHOUT consuming credits — record a real run once,
 * replay it forever.
 *
 * OFF by default: createRecorder(undefined) returns a no-op `record` so there is
 * zero prod overhead (one no-op function call in the hot path). Enable by passing
 * a directory (from env TRANSCRIPT_RECORD_DIR); the recorder writes one NDJSON
 * file per run at <dir>/<conversationId>-<runId>.ndjson.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** One recorded line. `layer` says which seam it came from; `data` is the RAW,
 *  un-normalized payload from that seam (the ground truth the fakes must match). */
export interface TranscriptEntry {
  /** ms since the recorder was created (run start). */
  t: number;
  /** Monotonic sequence across the whole run (all layers interleaved). */
  seq: number;
  layer: "acp-in" | "sdk-in" | "agui-out";
  provider: "goose" | "claude";
  /** The conversation + run this entry belongs to (correlation keys). */
  conversationId: string;
  runId: string;
  /** The raw frame / message / event. Serialized as-is. */
  data: unknown;
}

export interface Recorder {
  /** True when recording is ON (a dir was configured). Lets callers skip building
   *  an entry object when it would just be discarded. */
  readonly enabled: boolean;
  /** Record one entry. No-op when disabled. `t`/`seq` are stamped internally. */
  record(entry: Omit<TranscriptEntry, "t" | "seq">): void;
}

const NOOP: Recorder = { enabled: false, record: () => {} };

/**
 * Create a recorder writing to `dir` (undefined/empty → a no-op recorder). Best
 * effort: any filesystem error is swallowed (recording must never break a run).
 * `now` is injectable for deterministic tests (defaults to Date.now).
 */
export function createRecorder(dir: string | undefined, now: () => number = Date.now): Recorder {
  if (!dir) return NOOP;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return NOOP; // can't create the dir → disable rather than throw
  }
  const start = now();
  let seq = 0;
  return {
    enabled: true,
    record(partial) {
      try {
        const entry: TranscriptEntry = { t: now() - start, seq: seq++, ...partial };
        const file = join(dir, `${partial.conversationId}-${partial.runId}.ndjson`);
        appendFileSync(file, JSON.stringify(entry) + "\n");
      } catch {
        /* recording is best-effort — never break the run */
      }
    },
  };
}
