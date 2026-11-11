/**
 * ToolGroupOpen: a run of one tool call renders its card bare (no "1 tool call" line);
 * two or more keep the open group with its count trigger.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToolGroupOpen } from "./ToolGroupOpen.js";
import type { ThreadGroupPart } from "@/components/assistant-ui/thread";

function group(indices: number[], running = false): ThreadGroupPart {
  return { type: "group-tool", indices, status: { type: running ? "running" : "complete" } } as never;
}

const card = createElement("div", { "data-testid": "card" }, "Shell · ran a command");

describe("ToolGroupOpen", () => {
  it("renders a single tool call without the group line", () => {
    const html = renderToStaticMarkup(createElement(ToolGroupOpen, { group: group([0]) }, card));
    expect(html).toBe('<div data-slot="tool-group-single"><div data-testid="card">Shell · ran a command</div></div>');
    expect(html).not.toContain("tool call");
  });

  it("keeps the open group and its count for two or more", () => {
    const html = renderToStaticMarkup(createElement(ToolGroupOpen, { group: group([0, 1, 2]) }, card, card, card));
    expect(html).toContain("3 tool calls");
    expect(html).toContain('data-state="open"');
    expect(html.match(/data-testid="card"/g)).toHaveLength(3);
  });
});
