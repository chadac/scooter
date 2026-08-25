/**
 * Tier 1 contract — a REAL POST /agui makes the conversation id ambient.
 *
 * The unit tests in log.spec.ts prove AsyncLocalStorage carries a context across awaits.
 * This proves the wiring: that an actual request through the server binds it, so a log
 * site deep inside the prompt handler gets the id without being handed one.
 *
 * That distinction matters. The whole design rests on entry points binding the context —
 * a logger that works perfectly in isolation and is never bound is worth nothing, and the
 * failure mode is silent (lines simply lack the field).
 */

import { describe, it, expect } from "vitest";

import { createAguiServer } from "../../src/agui/server.js";
import { currentContext, logger, reconfigureLogging } from "../../src/log.js";

describe("POST /agui binds the log context", () => {
  it("makes the conversation id ambient inside the prompt handler", async () => {
    const server = createAguiServer();
    let seen: string | undefined;
    let seenAfterAwait: string | undefined;

    server.onPrompt(async () => {
      // What a log site inside the handler would pick up — no id parameter in sight.
      seen = currentContext().conversation_id;
      // ...and it must still be there after an await, since the real handler provisions a
      // sandbox and spawns a bridge before most of its logging happens.
      await new Promise((r) => setTimeout(r, 5));
      seenAfterAwait = currentContext().conversation_id;
    });

    await server.listen(0);
    const ctrl = new AbortController();
    try {
      void fetch(`http://127.0.0.1:${server.port()}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "conv-from-the-wire",
          runId: "r1",
          messages: [{ id: "m1", role: "user", content: "hello" }],
        }),
        signal: ctrl.signal,
      }).catch(() => {});
      for (let i = 0; i < 100 && seenAfterAwait === undefined; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
    } finally {
      ctrl.abort();
      await server.close();
    }

    expect(seen).toBe("conv-from-the-wire");
    expect(seenAfterAwait).toBe("conv-from-the-wire");
  });

  it("does not leak one request's conversation into the next", async () => {
    const server = createAguiServer();
    const seen: (string | undefined)[] = [];
    server.onPrompt(async () => {
      seen.push(currentContext().conversation_id);
    });
    await server.listen(0);

    const post = async (threadId: string) => {
      const ctrl = new AbortController();
      void fetch(`http://127.0.0.1:${server.port()}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, runId: "r1", messages: [{ id: "m", role: "user", content: "x" }] }),
        signal: ctrl.signal,
      }).catch(() => {});
      const want = seen.length + 1;
      for (let i = 0; i < 100 && seen.length < want; i++) await new Promise((r) => setTimeout(r, 10));
      ctrl.abort();
    };

    try {
      await post("conv-A");
      await post("conv-B");
    } finally {
      await server.close();
    }

    expect(seen).toEqual(["conv-A", "conv-B"]);
  });

  it("a line logged from inside the handler CARRIES the id", async () => {
    // The end-to-end claim, stated as the operator would ask it: a log written during a
    // prompt is attributable to its conversation without anyone plumbing the id there.
    process.env.LOG_FORMAT = "json";
    reconfigureLogging();
    const lines: Record<string, unknown>[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
      try {
        lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
      } catch {
        /* not one of ours */
      }
    };

    const server = createAguiServer();
    server.onPrompt(async () => {
      // Pretend to be the bridge, five frames down, logging something interesting.
      logger("bridge").info("prompt queued");
    });
    await server.listen(0);
    const ctrl = new AbortController();
    try {
      void fetch(`http://127.0.0.1:${server.port()}/agui`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId: "conv-logged",
          runId: "r1",
          messages: [{ id: "m", role: "user", content: "x" }],
        }),
        signal: ctrl.signal,
      }).catch(() => {});
      for (let i = 0; i < 100 && lines.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    } finally {
      ctrl.abort();
      await server.close();
      console.log = realLog;
      delete process.env.LOG_FORMAT;
      reconfigureLogging();
    }

    const queued = lines.find((l) => l.msg === "prompt queued");
    expect(queued).toBeDefined();
    expect(queued?.conversation_id).toBe("conv-logged");
    expect(queued?.component).toBe("bridge");
  });
});
