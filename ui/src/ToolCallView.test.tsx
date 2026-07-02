/**
 * UI unit test — the ToolCallView tool-fallback override.
 *
 * A provider "post" tool renders as a message card (icon + body + result); a
 * non-provider tool delegates to the stock generic ToolFallback. Rendering the
 * card actually invokes SourceBadge, so a dropped provider icon throws here.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToolCallView } from "./ToolCallView.js";

// Minimal ToolCallMessagePartProps — only the fields ToolCallView reads.
function part(over: Record<string, unknown>) {
  return {
    type: "tool-call",
    toolCallId: "t1",
    toolName: "",
    args: {},
    argsText: "{}",
    status: { type: "complete" },
    ...over,
  } as never;
}

describe("ToolCallView", () => {
  it("renders a Slack message card with the icon, body, and result", () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallView, part({
        toolName: "Respond in the Slack thread",
        args: { text: "on it" },
        result: "posted to the thread",
      })),
    );
    expect(html).toContain("provider-tool-card");
    expect(html).toContain('data-provider="slack"');
    expect(html).toContain("on it");                 // the body
    expect(html).toContain("posted to the thread");  // the result
    expect(html).toContain("<svg");                  // the Slack icon rendered
  });

  it("shows a GitHub comment card", () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallView, part({ toolName: "Comment on the GitHub PR/issue", args: { body: "LGTM" } })),
    );
    expect(html).toContain('data-provider="github"');
    expect(html).toContain("LGTM");
  });

  it("delegates to the generic ToolFallback for a non-provider tool", () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallView, part({ toolName: "run ls", argsText: '{"command":"ls"}' })),
    );
    // NOT a provider card; the stock fallback renders its own markup instead.
    expect(html).not.toContain("provider-tool-card");
  });
});
