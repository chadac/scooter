import { describe, expect, it } from "vitest";

import { toolNames, toolRunAt, toolRunOpen, type RunMessage } from "./toolRuns.js";

const tools = (id: string, ...names: string[]): RunMessage => ({
  id,
  role: "assistant",
  content: names.map((toolName) => ({ type: "tool-call", toolName })),
});
const text = (id: string, role = "assistant"): RunMessage => ({ id, role, content: [{ type: "text" }] });

describe("toolRunAt", () => {
  const thread = [
    text("u1", "user"),
    tools("a", "grep"),
    tools("b", "read_file", "grep"),
    tools("c", "mcp__sandbox__bash"),
    text("d"),
    tools("e", "edit"),
  ];

  it("gathers consecutive tool-only messages into one run led by the first", () => {
    expect(toolRunAt(thread, 1)).toEqual({ leaderId: "a", isLeader: true, count: 4, names: ["grep", "read_file", "bash"], running: false });
    expect(toolRunAt(thread, 3)).toMatchObject({ leaderId: "a", isLeader: false, count: 4 });
  });

  it("ends a run at a message holding text", () => {
    expect(toolRunAt(thread, 5)).toMatchObject({ leaderId: "e", isLeader: true, count: 1, names: ["edit"] });
  });

  it("has no run for a message holding more than tool calls", () => {
    expect(toolRunAt(thread, 0)).toBeUndefined();
    expect(toolRunAt(thread, 4)).toBeUndefined();
    expect(toolRunAt([{ id: "m", role: "assistant", content: [{ type: "tool-call" }, { type: "text" }] }], 0)).toBeUndefined();
    expect(toolRunAt([{ id: "m", role: "assistant", content: [] }], 0)).toBeUndefined();
  });

  it("is running while any of its messages is", () => {
    const live = [tools("a", "grep"), { ...tools("b", "bash"), status: { type: "running" } }];
    expect(toolRunAt(live, 0)?.running).toBe(true);
  });
});

describe("toolNames", () => {
  it("lists distinct names in call order, without MCP server prefixes", () => {
    const calls = [{ toolName: "mcp__scooter-broker__kanban_set_status" }, { toolName: "bash" }, {}, { toolName: "bash" }];
    expect(toolNames(calls)).toEqual(["kanban_set_status", "bash"]);
  });
});

describe("toolRunOpen", () => {
  it("toggles a run open and shut, notifying subscribers", () => {
    let calls = 0;
    const off = toolRunOpen.subscribe(() => calls++);
    toolRunOpen.toggle("lead");
    expect(toolRunOpen.get("lead")).toBe(true);
    toolRunOpen.toggle("lead");
    expect(toolRunOpen.get("lead")).toBe(false);
    off();
    expect(calls).toBe(2);
  });
});
