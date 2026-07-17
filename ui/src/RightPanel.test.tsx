/**
 * UI unit test — the right-side tabbed panel (Approvals + Queue). SSR render (the
 * house style, no jsdom), so this covers the STRUCTURE: collapse-when-both-empty, the
 * tab bar + count badges, and that Approvals is the default-active tab (its content
 * shows on first render). The interactive bits — clicking to the Queue tab and the
 * auto-focus-Approvals-on-new-interrupt effect — need a real DOM and are covered by
 * the Playwright e2e (test/e2e/interrupt.spec.ts + queue coverage).
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RightPanel } from "./RightPanel.js";
import { InterruptContext, type InterruptContextValue } from "./RuntimeProvider.js";
import type { PendingInterrupt } from "./integrityAgent.js";

function render(over: Partial<InterruptContextValue>): string {
  const value = {
    interrupts: [],
    submitResume: async () => {},
    conversationId: "c1",
    baseUrl: "",
    isRunning: true,
    cancel: async () => {},
    cancelState: "idle",
    runError: null,
    queuedMessages: [],
    renderTick: 0,
    ...over,
  } as InterruptContextValue;
  return renderToStaticMarkup(createElement(InterruptContext.Provider, { value }, createElement(RightPanel)));
}

const interrupt = (id: string, message: string): PendingInterrupt => ({
  id,
  reason: "option",
  message,
  metadata: { options: [{ optionId: "ok", name: "OK", kind: "primary" }] },
});

describe("RightPanel", () => {
  it("renders nothing when both approvals and queue are empty", () => {
    expect(render({})).toBe("");
  });

  it("shows the panel + both tabs when only the queue is non-empty", () => {
    const html = render({ queuedMessages: [{ id: "q1", text: "hello queued", priority: 0 }] });
    expect(html).toContain('data-testid="right-panel"');
    expect(html).toContain('data-testid="right-panel-tab-approvals"');
    expect(html).toContain('data-testid="right-panel-tab-queue"');
    // Queue badge shows the count; approvals badge is absent (count 0).
    expect(html).toContain('data-testid="right-panel-badge-queue"');
    expect(html).not.toContain('data-testid="right-panel-badge-approvals"');
  });

  it("defaults to the Approvals tab and renders its content (interrupt-panel) when pending", () => {
    const html = render({ interrupts: [interrupt("i1", "approve the deploy?")] });
    expect(html).toContain('data-testid="right-panel"');
    // Approvals is the default-active tab, so its content region renders on first paint.
    expect(html).toContain('data-testid="interrupt-panel"');
    expect(html).toContain("approve the deploy?");
    expect(html).toContain('data-testid="right-panel-badge-approvals"');
  });

  it("with pending approvals AND a queue, still defaults to Approvals content (the gate)", () => {
    const html = render({
      interrupts: [interrupt("i1", "gate")],
      queuedMessages: [{ id: "q1", text: "QUEUED_MSG_SENTINEL", priority: 0 }],
    });
    // Default tab is Approvals -> its content shows; the queued text is NOT rendered
    // yet (it lives in the inactive Queue tab).
    expect(html).toContain('data-testid="interrupt-panel"');
    expect(html).not.toContain("QUEUED_MSG_SENTINEL");
    // Both badges present with their counts.
    expect(html).toContain('data-testid="right-panel-badge-approvals"');
    expect(html).toContain('data-testid="right-panel-badge-queue"');
  });
});
