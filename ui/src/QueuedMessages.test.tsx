/**
 * UI unit test — the queued-messages strip renders the durable queue from context
 * (the queued-message-vanishes-on-refresh fix: the queue now rides the integrity
 * stream, so it's surfaced via RuntimeProvider context rather than client memory).
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { QueuedMessages } from "./QueuedMessages.js";
import { InterruptContext, type InterruptContextValue } from "./RuntimeProvider.js";

function render(queuedMessages: InterruptContextValue["queuedMessages"]): string {
  const value = {
    interrupts: [],
    submitResume: async () => {},
    conversationId: "c1",
    baseUrl: "",
    isRunning: true,
    cancel: async () => {},
    cancelState: "idle",
    runError: null,
    queuedMessages,
    renderTick: 0,
  } as InterruptContextValue;
  return renderToStaticMarkup(createElement(InterruptContext.Provider, { value }, createElement(QueuedMessages)));
}

describe("QueuedMessages", () => {
  it("renders nothing when the queue is empty", () => {
    expect(render([])).toBe("");
  });

  it("renders each queued message + a count", () => {
    const html = render([
      { id: "q1", text: "first queued", priority: 0 },
      { id: "q2", text: "second queued", priority: 10 },
    ]);
    expect(html).toContain('data-testid="queued-messages"');
    expect(html).toContain("Queued (2)");
    expect(html).toContain("first queued");
    expect(html).toContain("second queued");
    // Two message rows.
    expect(html.match(/data-testid="queued-message"/g)).toHaveLength(2);
  });
});
