/**
 * The ToolCallView tool-fallback override.
 *
 * A provider "post" tool renders as a message card (icon, body, result); a
 * non-provider tool delegates to the stock generic ToolFallback. Rendering the
 * card invokes SourceBadge, so a dropped provider icon throws here.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ToolCallView } from "./ToolCallView.js";
import { InterruptContext, type InterruptContextValue } from "./RuntimeProvider.js";

/** Render a tool card inside an InterruptContext with the given run state, to exercise the "still running" spinner. */
function renderWithRun(el: React.ReactElement, isRunning: boolean): string {
  const value = {
    interrupts: [],
    submitResume: async () => {},
    conversationId: "c1",
    baseUrl: "",
    isRunning,
    cancel: async () => {},
    cancelState: "idle",
    runError: null,
    queuedMessages: [],
    renderTick: 0,
  } as InterruptContextValue;
  return renderToStaticMarkup(createElement(InterruptContext.Provider, { value }, el));
}

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
        // The server-prefixed, title-cased form the stream carries.
        toolName: "Scooter-env: Slack Respond",
        args: { text: "on it" },
        // The ACP content-array result shape, not a plain string.
        result: [{ content: { text: "Posted to the Slack thread.", type: "text" }, type: "content" }],
      })),
    );
    expect(html).toContain("provider-tool-card");
    expect(html).toContain('data-provider="slack"');
    expect(html).toContain("on it");                       // the POSTED text (body)
    expect(html).toContain("Posted to the Slack thread.");  // the result — unwrapped, clean
    expect(html).not.toContain('"type":"content"');         // not the raw JSON blob
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
        // The shell result is a terminal handle with no stdout, which must not be dumped as raw JSON.
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
    // Not a provider/shell card; the stock fallback renders its own markup.
    expect(html).not.toContain("provider-tool-card");
  });

  it("offers no inline Allow/Deny on a tool call left without a result", () => {
    // Approvals are answered in the Approvals panel; the chat card has no way to answer one.
    const html = renderWithRun(
      createElement(ToolCallView, part({
        toolName: "deploy_service",
        argsText: "{\"env\":\"prod\"}",
        status: { type: "requires-action", reason: "tool-calls" },
      })),
      false,
    );
    expect(html).not.toMatch(/Allow|Deny/);
  });

  it("shows a generic tool result's images while the card is collapsed", () => {
    const url = "/conversations/c1/assets/abc.png";
    const html = renderToStaticMarkup(
      createElement(ToolCallView, part({
        toolName: "mcp__scooter-env__view_image",
        args: { path: "/workspace/shot.png" },
        result: [{ type: "image", mimeType: "image/png", assetId: "abc.png", url }, { type: "text", text: "[Image: source: x]" }],
      })),
    );
    expect(html).not.toContain("provider-tool-card");
    expect(html).toContain('data-slot="media-strip"');
    expect(html).toContain(url);
    // The card stays collapsed: the result's text is not rendered until it is opened.
    expect(html).not.toContain("[Image: source: x]");
  });

  it("plays a show_video result inline while the card is collapsed", () => {
    const url = "/conversations/c1/assets/abc.mp4";
    const ref = JSON.stringify({ type: "video", mimeType: "video/mp4", assetId: "abc.mp4", url });
    const html = renderToStaticMarkup(
      createElement(ToolCallView, part({
        toolName: "mcp__scooter-env__show_video",
        args: { path: "/workspace/demo.mp4" },
        result: [{ type: "text", text: ref }, { type: "text", text: "Showing /workspace/demo.mp4" }],
      })),
    );
    expect(html).toContain('data-slot="media-video"');
    expect(html).toContain(`src="${url}"`);
    expect(html).toContain('type="video/mp4"');
    expect(html).not.toContain("Showing /workspace/demo.mp4");
  });

  it("shows a running spinner on a shell card while the turn is in flight and no result yet", () => {
    // Status is always complete, so the spinner comes from our run state (result undefined plus isRunning).
    const html = renderWithRun(
      createElement(ToolCallView, part({ toolName: "Shell", args: { command: "sleep 20" }, result: undefined })),
      true,
    );
    expect(html).toContain("provider-tool-running"); // the spinner + "running…"
    expect(html).toContain("running…");
  });

  it("shows NO spinner once the shell tool has a result (finished), even mid-run", () => {
    const html = renderWithRun(
      createElement(ToolCallView, part({
        toolName: "Shell",
        args: { command: "ls" },
        result: [{ terminalId: "term-1", type: "terminal" }], // finished
      })),
      true,
    );
    expect(html).not.toContain("provider-tool-running");
  });

  it("shows NO spinner when the turn is idle (no run in flight)", () => {
    const html = renderWithRun(
      createElement(ToolCallView, part({ toolName: "Shell", args: { command: "sleep 20" }, result: undefined })),
      false,
    );
    expect(html).not.toContain("provider-tool-running");
  });
});
