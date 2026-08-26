/**
 * Tier 1 — structured logging.
 *
 * Two things carry the weight here and both have burned us:
 *
 *   1. The conversation id must ride EVERY line inside a scope, including across awaits.
 *      An id that survives the first tick and then vanishes is worse than none, because
 *      the trace looks complete while missing the interesting half.
 *   2. formatError must never produce `{}`. Two production failures were unattributable
 *      for exactly that reason ("[k8sExec] exec() rejected {}").
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  formatError,
  logger,
  reconfigureLogging,
  withContext,
  withConversation,
  currentContext,
} from "../../src/log.js";

/** Capture stdout/stderr lines as parsed JSON. */
function captureJson() {
  const lines: Record<string, unknown>[] = [];
  const take = (...args: unknown[]) => {
    lines.push(JSON.parse(String(args[0])) as Record<string, unknown>);
  };
  vi.spyOn(console, "log").mockImplementation(take);
  vi.spyOn(console, "error").mockImplementation(take);
  return lines;
}

describe("structured logging", () => {
  beforeEach(() => {
    process.env.LOG_FORMAT = "json";
    process.env.LOG_LEVEL = "debug";
    reconfigureLogging();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_FORMAT;
    delete process.env.LOG_LEVEL;
    reconfigureLogging();
  });

  it("emits one JSON object per line with the standard fields", () => {
    const lines = captureJson();
    logger("bridge").info("prompt queued", { queue_depth: 3 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "info",
      service: "agent-host",
      component: "bridge",
      msg: "prompt queued",
      queue_depth: 3,
    });
    expect(typeof lines[0].ts).toBe("string");
  });

  it("attaches the conversation id to every line in scope", () => {
    const lines = captureJson();
    withConversation("conv-1", () => {
      logger("bridge").info("first");
      logger("exec").warn("second");
    });
    logger("bridge").info("outside");

    expect(lines[0].conversation_id).toBe("conv-1");
    expect(lines[1].conversation_id).toBe("conv-1");
    // ...and does NOT leak past the scope.
    expect(lines[2].conversation_id).toBeUndefined();
  });

  it("SURVIVES awaits — the case that makes ambient context worth having", async () => {
    // A log site five frames deep, after an await, is exactly where the id used to be
    // unavailable. If AsyncLocalStorage did not carry across the await this whole design
    // would be pointless, so pin it.
    const lines = captureJson();
    await withConversation("conv-async", async () => {
      logger("a").info("before await");
      await new Promise((r) => setTimeout(r, 5));
      logger("a").info("after await");
      await Promise.resolve();
      logger("a").info("after microtask");
    });

    expect(lines.map((l) => l.conversation_id)).toEqual(["conv-async", "conv-async", "conv-async"]);
  });

  it("survives into callbacks scheduled inside the scope", async () => {
    const lines = captureJson();
    await new Promise<void>((resolve) => {
      withConversation("conv-cb", () => {
        setTimeout(() => {
          logger("later").info("from a timer");
          resolve();
        }, 1);
      });
    });
    expect(lines[0].conversation_id).toBe("conv-cb");
  });

  it("MERGES nested contexts instead of replacing them", () => {
    const lines = captureJson();
    withConversation("conv-1", () => {
      withContext({ run_id: "run-9" }, () => logger("bridge").info("in a run"));
    });
    expect(lines[0]).toMatchObject({ conversation_id: "conv-1", run_id: "run-9" });
  });

  it("keeps concurrent conversations separate", async () => {
    const lines = captureJson();
    await Promise.all([
      withConversation("conv-A", async () => {
        await new Promise((r) => setTimeout(r, 10));
        logger("x").info("A finished");
      }),
      withConversation("conv-B", async () => {
        await new Promise((r) => setTimeout(r, 1));
        logger("x").info("B finished");
      }),
    ]);
    // B logs first (shorter sleep); each must carry its OWN id, not the other's.
    expect(lines.map((l) => [l.msg, l.conversation_id])).toEqual([
      ["B finished", "conv-B"],
      ["A finished", "conv-A"],
    ]);
  });

  it("respects LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    reconfigureLogging();
    const lines = captureJson();
    const log = logger("x");
    log.debug("no");
    log.info("no");
    log.warn("yes");
    log.error("yes");
    expect(lines.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("does not lose a line containing an unserializable field", () => {
    const lines = captureJson();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger("x").info("cyclic", { circular })).not.toThrow();
    expect(lines[0].msg).toBe("cyclic");
  });
});

describe("formatError — never `{}`", () => {
  it("keeps message, name and stack for a real Error", () => {
    const out = formatError(new Error("boom"));
    expect(out.message).toBe("boom");
    expect(out.name).toBe("Error");
    expect(typeof out.stack).toBe("string");
  });

  it("keeps the status/code fields k8s and http clients attach", () => {
    const out = formatError(Object.assign(new Error("nope"), { code: 409, reason: "Conflict" }));
    expect(out).toMatchObject({ message: "nope", code: 409, reason: "Conflict" });
  });

  it("captures NON-ENUMERABLE fields, which JSON.stringify silently drops", () => {
    // This is the actual production bug: a WebSocket/k8s client error stringifies to `{}`
    // because its useful fields are non-enumerable.
    const err = {};
    Object.defineProperty(err, "message", { value: "hidden", enumerable: false });
    expect(JSON.stringify(err)).toBe("{}"); // the old behavior
    expect(formatError(err).message).toBe("hidden"); // the new one
  });

  it("says so explicitly when a thrown value really has no properties", () => {
    // k8sExec.ts already used getOwnPropertyNames and STILL logged `{}` — meaning the
    // value genuinely had nothing. Emitting a note beats emitting an empty object.
    const out = formatError({});
    expect(out.note).toMatch(/no own properties/);
  });

  it("handles non-objects", () => {
    expect(formatError("a string").message).toBe("a string");
    expect(formatError(undefined).message).toBe("undefined");
    expect(formatError(null).message).toBe("null");
  });

  it("unwraps a cause chain", () => {
    const out = formatError(new Error("outer", { cause: new Error("inner") }));
    expect((out.cause as Record<string, unknown>).message).toBe("inner");
  });

  it("errorWith() puts the formatted error on the line", () => {
    process.env.LOG_FORMAT = "json";
    reconfigureLogging();
    const lines = captureJson();
    logger("k8sExec").errorWith("exec() rejected", new Error("socket closed"));
    const err = lines[0].error as Record<string, unknown>;
    expect(err.message).toBe("socket closed");
    vi.restoreAllMocks();
  });
});

describe("the production failures this replaces", () => {
  beforeEach(() => {
    process.env.LOG_FORMAT = "json";
    reconfigureLogging();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_FORMAT;
    reconfigureLogging();
  });

  it("an exec failure is diagnosable instead of `{}`", () => {
    // "[k8sExec] exec() rejected {}" — the reported bug. A WebSocket error carries its
    // detail non-enumerably, so the old console.error rendered nothing usable.
    const wsErr = {};
    Object.defineProperty(wsErr, "message", { value: "socket hang up", enumerable: false });
    Object.defineProperty(wsErr, "code", { value: "ECONNRESET", enumerable: false });

    const lines = captureJson();
    withConversation("conv-1", () => {
      logger("k8sExec").errorWith("exec() rejected", wsErr, { ws_close: { code: 1006, reason: "" } });
    });

    const line = lines[0];
    expect(line.conversation_id).toBe("conv-1"); // WHICH conversation — previously absent
    expect((line.error as Record<string, unknown>).message).toBe("socket hang up");
    expect((line.error as Record<string, unknown>).code).toBe("ECONNRESET");
    expect(line.ws_close).toEqual({ code: 1006, reason: "" });
  });

  it("a failed prompt names its conversation", () => {
    // "[agui] prompt failed for <id>" had the id interpolated into prose — greppable by
    // eye, not queryable. It is a field now.
    const lines = captureJson();
    withConversation("42bb375c", () => {
      logger("agui").errorWith("prompt failed; surfacing RUN_ERROR to the client", new Error("nope"), {
        unknown_conversation: true,
      });
    });
    expect(lines[0]).toMatchObject({
      conversation_id: "42bb375c",
      component: "agui",
      unknown_conversation: true,
    });
  });
});
