/**
 * Transcript REPLAY support — load a recorded NDJSON transcript and turn its RAW
 * input frames into a fake that drives the REAL bridge, so tests run against the
 * exact shapes real goose/claude emit (not hand-authored fictions).
 *
 * See todo/docs/AGENT_TRANSCRIPT_HARNESS.md. Fixtures live under
 * test/fixtures/transcripts/<provider>/<scenario>.ndjson.
 */

import { readFileSync } from "node:fs";

import type { TranscriptEntry } from "../../src/transcript/recorder.js";
import type { SessionUpdate } from "../../src/acp/client.js";

export type { TranscriptEntry };

/** Parse an NDJSON transcript into ordered entries. */
export function loadTranscript(path: string): TranscriptEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TranscriptEntry);
}

/** The RAW input entries only (acp-in / sdk-in), in record order — what the fake
 *  agent/query must reproduce. */
export function inputEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((e) => e.layer === "acp-in" || e.layer === "sdk-in");
}

/** The AG-UI output the bridge produced for this transcript (what a replay can
 *  assert its own bridge re-produces). */
export function aguiOutEntries(entries: TranscriptEntry[]): unknown[] {
  return entries.filter((e) => e.layer === "agui-out").map((e) => e.data);
}

/** The recorded goose ACP updates (sessionUpdate frames) for a transcript — feed
 *  these to the fake ACP agent so it emits REAL shapes. */
export function acpUpdates(entries: TranscriptEntry[]): SessionUpdate[] {
  return entries.filter((e) => e.layer === "acp-in").map((e) => e.data as SessionUpdate);
}

/** The recorded RAW claude SDK query() messages — feed these to a fake query() so
 *  it yields REAL shapes (the layer that lied about tool_result). */
export function sdkMessages(entries: TranscriptEntry[]): unknown[] {
  return entries.filter((e) => e.layer === "sdk-in").map((e) => e.data);
}

/**
 * A fake SDK query() that REPLAYS recorded claude messages verbatim — a drop-in
 * for createSdkAcpClient's `queryImpl`. Records calls + honors interrupt() (stops
 * yielding remaining messages, mirroring a real turn cut short by back-pressure).
 * This is how a test drives the real sdkClient with REAL message shapes.
 */
export function replaySdkQuery(messages: unknown[]) {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  let interrupted = false;
  const queryImpl = (params: { prompt: string; options: Record<string, unknown> }) => {
    calls.push({ prompt: params.prompt, options: params.options });
    async function* gen() {
      for (const msg of messages) {
        if (interrupted) return; // a back-pressure interrupt stops the stream
        yield msg as never;
        // Yield to the event loop so an interrupt() triggered by a callback during
        // this message is observed before the next one (models real async streaming).
        await Promise.resolve();
      }
    }
    return Object.assign(gen(), { interrupt: async () => { interrupted = true; } });
  };
  return { queryImpl, calls, wasInterrupted: () => interrupted };
}
