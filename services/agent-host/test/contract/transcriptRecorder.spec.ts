/**
 * Tier 1 — the transcript recorder. OFF by default (no-op, zero overhead); when a
 * dir is set, writes one NDJSON file per run with correlated, sequenced entries.
 * See todo/docs/AGENT_TRANSCRIPT_HARNESS.md.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRecorder, type TranscriptEntry } from "../../src/transcript/recorder.js";

describe("transcript recorder", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "transcript-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("is a NO-OP when no dir is given (recording OFF by default)", () => {
    const rec = createRecorder(undefined);
    expect(rec.enabled).toBe(false);
    // Must not throw / must not write anything.
    rec.record({ layer: "agui-out", provider: "claude", conversationId: "c1", runId: "r1", data: { type: "X" } });
    expect(readdirSync(dir)).toEqual([]); // nothing written
  });

  it("writes one NDJSON file per run, named <conversationId>-<runId>.ndjson", () => {
    const rec = createRecorder(dir);
    expect(rec.enabled).toBe(true);
    rec.record({ layer: "sdk-in", provider: "claude", conversationId: "c1", runId: "r1", data: { type: "assistant" } });
    rec.record({ layer: "agui-out", provider: "claude", conversationId: "c1", runId: "r2", data: { type: "RUN_STARTED" } });

    expect(existsSync(join(dir, "c1-r1.ndjson"))).toBe(true);
    expect(existsSync(join(dir, "c1-r2.ndjson"))).toBe(true);
  });

  it("stamps a monotonic seq and a relative timestamp; preserves the RAW data verbatim", () => {
    let clock = 1000;
    const rec = createRecorder(dir, () => clock);
    clock = 1005;
    rec.record({ layer: "sdk-in", provider: "claude", conversationId: "c1", runId: "r1", data: { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "check_subagent" }] } } });
    clock = 1012;
    rec.record({ layer: "agui-out", provider: "claude", conversationId: "c1", runId: "r1", data: { type: "TOOL_CALL_START", toolCallId: "t1" } });

    const lines = readFileSync(join(dir, "c1-r1.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as TranscriptEntry);
    expect(lines).toHaveLength(2);
    expect(lines[0].seq).toBe(0);
    expect(lines[1].seq).toBe(1);
    expect(lines[0].t).toBe(5);  // 1005 - 1000 (start)
    expect(lines[1].t).toBe(12); // 1012 - 1000
    // The RAW shape is preserved exactly — this is the ground truth for the fakes.
    expect((lines[0].data as { message: { content: unknown[] } }).message.content).toEqual([{ type: "tool_use", id: "t1", name: "check_subagent" }]);
    expect(lines[0].layer).toBe("sdk-in");
    expect(lines[1].layer).toBe("agui-out");
  });

  it("interleaves all layers of one run in a single file, in record order", () => {
    const rec = createRecorder(dir);
    rec.record({ layer: "sdk-in", provider: "claude", conversationId: "c1", runId: "r1", data: 1 });
    rec.record({ layer: "agui-out", provider: "claude", conversationId: "c1", runId: "r1", data: 2 });
    rec.record({ layer: "sdk-in", provider: "claude", conversationId: "c1", runId: "r1", data: 3 });
    const lines = readFileSync(join(dir, "c1-r1.ndjson"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as TranscriptEntry);
    expect(lines.map((l) => l.layer)).toEqual(["sdk-in", "agui-out", "sdk-in"]);
    expect(lines.map((l) => l.data)).toEqual([1, 2, 3]);
  });
});
