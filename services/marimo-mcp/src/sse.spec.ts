/** Unit — the SSE parser + fold. The marimo execute stream shape is the contract;
 *  these lock the exact frames execute-code.sh consumes. */

import { describe, it, expect } from "vitest";

import { parseSseEvents, foldExecute } from "./sse.js";

const stream = (lines: string[]) => lines.join("\n");

describe("parseSseEvents", () => {
  it("parses stdout/stderr/done frames", () => {
    const body = stream([
      "event: stdout",
      'data: {"data":"hello\\n"}',
      "",
      "event: stderr",
      'data: {"data":"a warning\\n"}',
      "",
      "event: done",
      'data: {"success":true,"output":{"data":"42"}}',
      "",
    ]);
    expect(parseSseEvents(body)).toEqual([
      { event: "stdout", data: "hello\n" },
      { event: "stderr", data: "a warning\n" },
      { event: "done", success: true, output: "42" },
    ]);
  });

  it("tolerates CRLF and unknown events", () => {
    const body = "event: ping\r\ndata: {}\r\n\r\nevent: done\r\ndata: {\"success\":true,\"output\":{}}\r\n\r\n";
    const events = parseSseEvents(body);
    expect(events).toEqual([{ event: "done", success: true, output: "" }]);
  });

  it("treats absent success as success; explicit false as failure", () => {
    expect(parseSseEvents('event: done\ndata: {"output":{"data":"x"}}')).toEqual([
      { event: "done", success: true, output: "x" },
    ]);
    expect(parseSseEvents('event: done\ndata: {"success":false,"output":{}}')).toEqual([
      { event: "done", success: false, output: "" },
    ]);
  });

  it("skips a non-JSON data line (an error body, not a frame)", () => {
    expect(parseSseEvents("data: Internal Server Error")).toEqual([]);
  });
});

describe("foldExecute", () => {
  it("concatenates stdout/stderr and carries the done result", () => {
    const r = foldExecute([
      { event: "stdout", data: "a" },
      { event: "stdout", data: "b" },
      { event: "stderr", data: "e" },
      { event: "done", success: true, output: "out" },
    ]);
    expect(r).toEqual({ success: true, stdout: "ab", stderr: "e", output: "out" });
  });

  it("returns null when there is no done frame (incomplete stream)", () => {
    expect(foldExecute([{ event: "stdout", data: "a" }])).toBeNull();
  });

  it("propagates a failure (success:false)", () => {
    const r = foldExecute([
      { event: "stderr", data: "Traceback…" },
      { event: "done", success: false, output: "" },
    ]);
    expect(r?.success).toBe(false);
    expect(r?.stderr).toContain("Traceback");
  });
});
