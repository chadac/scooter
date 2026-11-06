/** A failed ACP request logs one summary line, never the request's content. */

import {
  AgentSideConnection,
  ClientSideConnection,
  type Agent,
  type Client,
} from "@zed-industries/agent-client-protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { installAcpSdkErrorLog } from "../../src/acp/sdkErrorLog.js";
import { reconfigureLogging } from "../../src/log.js";

/** An in-memory client/agent pair whose client fails every file write. */
function connectPair() {
  const a = new TransformStream();
  const b = new TransformStream();
  let agentConn!: AgentSideConnection;
  new ClientSideConnection(
    () =>
      ({
        async writeTextFile(p) {
          throw new Error(`upload ${p.path}: tee: ${p.path}: No such file or directory`);
        },
      }) as Client,
    { writable: a.writable, readable: b.readable },
  );
  new AgentSideConnection((conn) => {
    agentConn = conn;
    return {} as Agent;
  }, { writable: b.writable, readable: a.readable });
  return agentConn;
}

describe("installAcpSdkErrorLog", () => {
  const lines: unknown[][] = [];
  beforeAll(() => {
    process.env.LOG_FORMAT = "json";
    reconfigureLogging();
    vi.spyOn(console, "error").mockImplementation((...args) => void lines.push(args));
    installAcpSdkErrorLog();
  });
  afterAll(() => {
    vi.restoreAllMocks();
    delete process.env.LOG_FORMAT;
    reconfigureLogging();
  });

  it("summarizes a failed fs/write_text_file without its content", async () => {
    const agent = connectPair();
    const content = "# Secret design\n## Open questions\n";
    await expect(
      agent.writeTextFile({ sessionId: "s1", path: "/workspace/designs/x.md", content }),
    ).rejects.toBeDefined();

    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(1);
    const text = String(lines[0]![0]);
    expect(text).not.toContain("Secret design");
    const line = JSON.parse(text) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: "error",
      component: "acp-sdk",
      msg: "Error handling request",
      method: "fs/write_text_file",
      acp_session_id: "s1",
      path: "/workspace/designs/x.md",
    });
    expect(String(line.error)).toContain("No such file or directory");
  });

  it("passes unrelated console.error calls through", () => {
    lines.length = 0;
    console.error("something else", { a: 1 });
    expect(lines).toEqual([["something else", { a: 1 }]]);
  });
});
