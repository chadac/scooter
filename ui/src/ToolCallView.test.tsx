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
        // The REAL form the stream carries (server-prefixed, title-cased).
        toolName: "Scooter-env: Slack Respond",
        args: { text: "on it" },
        // The REAL result shape — the ACP content-array blob, NOT a plain string.
        result: [{ content: { text: "Posted to the Slack thread.", type: "text" }, type: "content" }],
      })),
    );
    expect(html).toContain("provider-tool-card");
    expect(html).toContain('data-provider="slack"');
    expect(html).toContain("on it");                       // the POSTED text (body)
    expect(html).toContain("Posted to the Slack thread.");  // the result — unwrapped, clean
    expect(html).not.toContain('"type":"content"');         // NOT the raw JSON blob
    expect(html).toContain("<svg");                         // the Slack icon rendered
  });

  it("shows a GitHub comment card", () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallView, part({ toolName: "Comment on the GitHub PR/issue", args: { body: "LGTM" } })),
    );
    expect(html).toContain('data-provider="github"');
    expect(html).toContain("LGTM");
  });

  it("shows a Shell command card ($ command), suppressing the noisy terminal-handle result", () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallView, part({
        toolName: "Shell",
        args: { command: "ls -la" },
        // The real shell result: a terminal HANDLE, no stdout (that streams into
        // the assistant text). Must NOT be dumped as raw JSON.
        result: [{ terminalId: "term-1", type: "terminal" }],
      })),
    );
    expect(html).toContain("provider-tool-card");
    expect(html).toContain('data-provider="shell"');
    expect(html).toContain("$ ls -la");                 // the command, shown
    expect(html).not.toContain("terminalId");           // the handle blob suppressed
    expect(html).not.toContain('"type":"terminal"');
  });

  it("delegates to the generic ToolFallback for a tool we don't specialize", () => {
    const html = renderToStaticMarkup(
      createElement(ToolCallView, part({ toolName: "Search the web (DuckDuckGo)", argsText: '{"query":"x"}' })),
    );
    // NOT a provider/shell card; the stock fallback renders its own markup instead.
    expect(html).not.toContain("provider-tool-card");
  });
});
