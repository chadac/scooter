// A never-ready sandbox fails a run once, without retries.

import { describe, it, expect } from "vitest";

import { createSessionBridge, type AguiEvent } from "../../src/bridge.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A bridge whose every run is dead on arrival. */
async function wedgedRun(sandboxNotReady?: () => string | undefined) {
  const agent = createFakeAcpAgent();
  agent.setScript([]);
  agent.gate();
  const exec = createSandboxExecBackend(createFakeSandboxApi());
  const bridge = createSessionBridge({
    config: { cwd: "/workspace", skillsDir: "/skills", agent: { command: "fake", args: [], env: {} }, sandbox: { name: "s", namespace: "ns" } },
    exec,
    acpClient: acpClientFromTransport(agent.transport, exec),
    firstActivityTimeoutMs: 20,
    deathRetryMax: 2,
    deathRetryBaseMs: 5,
    sandboxNotReady,
  });
  const events: AguiEvent[] = [];
  bridge.onEvent((e) => events.push(e));
  await bridge.start();
  void bridge.prompt({ threadId: "t1", text: "hello" });
  await tick(200);
  await bridge.stop();
  return events;
}

describe("a run on a never-ready sandbox", () => {
  it("is not retried, and says the sandbox is not ready and why", async () => {
    const events = await wedgedRun(() => "pod Pending (ContainerCreating); FailedAttachVolume x3: attach timed out");

    expect(events.filter((e) => e.type === "RUN_STARTED")).toHaveLength(1);
    expect(events.filter((e) => e.type === "RUN_RETRYING")).toHaveLength(0);
    const last = events.filter((e) => e.type === "RUN_ERROR").at(-1) as { code?: string; message?: string };
    expect(last.code).toBe("sandbox_not_ready");
    expect(last.message).toContain("FailedAttachVolume x3: attach timed out");
  });

  it("is still retried while the sandbox's pod wait hasn't failed", async () => {
    const events = await wedgedRun(() => undefined);

    expect(events.filter((e) => e.type === "RUN_RETRYING")).toHaveLength(2);
    expect(events.some((e) => (e as { code?: string }).code === "sandbox_not_ready")).toBe(false);
  });
});
