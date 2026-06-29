/**
 * Tier 1 contract test — the ACP sandbox client handlers under CONCURRENCY.
 *
 * This is the regression guard for the parallel-tool-call hang: goose firing
 * several bash tool calls at once. Each call is a createTerminal -> terminalOutput
 * -> waitForTerminalExit -> releaseTerminal sequence over the SAME handler set,
 * keyed by terminal id. If two concurrent terminals ever shared an id (the old
 * hash(command+args) bug), they'd clobber each other's handle/buffer and an
 * orphaned waitForTerminalExit would never resolve -> hang.
 */

import { describe, it, expect } from "vitest";

import { createSandboxClientHandlers } from "../../src/acp/sandboxHandlers.js";
import type { ExecBackend, ExecRequest, TerminalHandle } from "../../src/types.js";

/** A fake ExecBackend whose spawned terminals are resolved MANUALLY, so a test
 *  can hold several execs open at once (true concurrency) and finish them in any
 *  order. Each spawn gets a unique id (like the real backend). */
function createControllableExec() {
  let seq = 0;
  const live = new Map<string, { resolve: (out: string, code: number) => void; output: string }>();

  const exec: ExecBackend = {
    async run(): Promise<never> {
      throw new Error("not used");
    },
    spawn(_req: ExecRequest): TerminalHandle {
      const id = `term-${++seq}`;
      const cbs = new Set<(c: string) => void>();
      let buffered = "";
      let resolveExit!: (e: { exitCode: number }) => void;
      const exitPromise = new Promise<{ exitCode: number }>((r) => (resolveExit = r));
      live.set(id, {
        output: "",
        resolve: (out, code) => {
          buffered += out;
          for (const cb of cbs) cb(out);
          resolveExit({ exitCode: code });
        },
      });
      return {
        id,
        onOutput(cb) {
          cbs.add(cb);
          if (buffered) cb(buffered);
        },
        waitForExit: () => exitPromise,
        async kill() {},
        async release() {
          cbs.clear();
        },
      };
    },
    async readTextFile() {
      return "";
    },
    async writeTextFile() {},
  };

  // Finish a specific spawned terminal (by 1-based spawn order) with output+code.
  const finish = (n: number, out: string, code: number) => {
    const entry = live.get(`term-${n}`);
    if (!entry) throw new Error(`no live terminal term-${n}`);
    entry.resolve(out, code);
  };

  return { exec, finish };
}

describe("ACP sandbox handlers — concurrent terminals", () => {
  it("three identical concurrent createTerminal calls get DISTINCT ids", async () => {
    const { exec } = createControllableExec();
    const h = createSandboxClientHandlers(exec);

    const reqs = await Promise.all(
      [0, 1, 2].map(() => h.createTerminal({ command: "bash", args: ["-c", "echo hi"] } as any)),
    );
    const ids = reqs.map((r) => r.terminalId);

    expect(new Set(ids).size).toBe(3); // no collision
  });

  it("each concurrent terminal keeps its OWN output + exit (no clobber, no hang)", async () => {
    const { exec, finish } = createControllableExec();
    const h = createSandboxClientHandlers(exec);

    // Open three identical terminals concurrently — none finished yet.
    const t1 = (await h.createTerminal({ command: "bash", args: ["-c", "x"] } as any)).terminalId;
    const t2 = (await h.createTerminal({ command: "bash", args: ["-c", "x"] } as any)).terminalId;
    const t3 = (await h.createTerminal({ command: "bash", args: ["-c", "x"] } as any)).terminalId;

    // Each waitForTerminalExit must resolve with ITS OWN exit code — a hang here
    // (an orphaned/overwritten handle) would time the test out.
    const exits = Promise.all([
      h.waitForTerminalExit({ terminalId: t1 } as any),
      h.waitForTerminalExit({ terminalId: t2 } as any),
      h.waitForTerminalExit({ terminalId: t3 } as any),
    ]);

    // Finish out of order, with distinct output + codes.
    finish(2, "two", 2);
    finish(1, "one", 1);
    finish(3, "three", 3);

    const [e1, e2, e3] = await exits;
    expect([e1.exitCode, e2.exitCode, e3.exitCode]).toEqual([1, 2, 3]);

    // Output buffers stayed isolated per terminal.
    expect((await h.terminalOutput({ terminalId: t1 } as any)).output).toBe("one");
    expect((await h.terminalOutput({ terminalId: t2 } as any)).output).toBe("two");
    expect((await h.terminalOutput({ terminalId: t3 } as any)).output).toBe("three");
  });

  it("releasing one terminal does NOT wipe a concurrent terminal's buffer", async () => {
    const { exec, finish } = createControllableExec();
    const h = createSandboxClientHandlers(exec);

    const t1 = (await h.createTerminal({ command: "bash", args: ["-c", "x"] } as any)).terminalId;
    const t2 = (await h.createTerminal({ command: "bash", args: ["-c", "x"] } as any)).terminalId;
    finish(1, "first", 0);
    finish(2, "second", 0);
    await h.waitForTerminalExit({ terminalId: t1 } as any);
    await h.waitForTerminalExit({ terminalId: t2 } as any);

    await h.releaseTerminal({ terminalId: t1 } as any);

    // t1 is gone; t2's output must survive.
    expect((await h.terminalOutput({ terminalId: t1 } as any)).output).toBe("");
    expect((await h.terminalOutput({ terminalId: t2 } as any)).output).toBe("second");
  });

  it("waitForTerminalExit on an unknown terminal returns a non-hanging error code", async () => {
    const { exec } = createControllableExec();
    const h = createSandboxClientHandlers(exec);
    const { exitCode } = await h.waitForTerminalExit({ terminalId: "term-nope" } as any);
    expect(exitCode).toBe(1);
  });
});
