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
import { InterruptContext, type InterruptContextValue } from "./RuntimeProvider.js";

/** Render a tool card inside an InterruptContext with the given run state, so we
 *  can exercise the "still running" spinner (which reads useConversationInterrupts). */
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

  it("shows a running spinner on a shell card while the turn is in flight and no result yet", () => {
    // result === undefined => not finished; isRunning => the live turn. The single-
    // source model FORCES status to complete, so the spinner comes from OUR run state.
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
