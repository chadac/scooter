import { describe, it, expect, vi } from "vitest";

import { summarizeConversation, type SummaryTurn } from "./summarize.js";

const turns: SummaryTurn[] = [
  { role: "user", text: "set up the deploy" },
  { role: "assistant", text: "done, pushed to odin" },
];

describe("summarizeConversation", () => {
  it("runs a tool-less query and returns the assistant text", async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const queryImpl = (params: { prompt: string; options: Record<string, unknown> }) => {
      calls.push(params);
      async function* gen() {
        yield { type: "assistant", message: { content: [{ type: "text", text: "Recap: deployed to odin." }] } };
        yield { type: "result", subtype: "success" };
      }
      return gen();
    };
    const out = await summarizeConversation(turns, { model: "m", oauthToken: "t", queryImpl });
    expect(out).toBe("Recap: deployed to odin.");
    // No tools / MCP servers — a pure completion.
    expect(calls[0].options.allowedTools).toEqual([]);
    expect(calls[0].options.mcpServers).toBeUndefined();
    expect(calls[0].prompt).toContain("set up the deploy");
  });

  it("empty turns → empty string (no query)", async () => {
    const queryImpl = vi.fn();
    expect(await summarizeConversation([], { model: "m", oauthToken: "t", queryImpl })).toBe("");
    expect(queryImpl).not.toHaveBeenCalled();
  });

  it("throws when the summarizer returns no text", async () => {
    const queryImpl = () => {
      async function* gen() { yield { type: "result", subtype: "success" }; }
      return gen();
    };
    await expect(summarizeConversation(turns, { model: "m", oauthToken: "t", queryImpl })).rejects.toThrow(/no text/);
  });
});
