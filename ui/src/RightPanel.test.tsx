/**
 * UI unit test — the right-side tabbed panel (Sandbox + Approvals + Queue + Services).
 * SSR render (the house style, no jsdom), so this covers the STRUCTURE: the persistent
 * Sandbox status tab (leftmost, always present + default-active on first paint), the tab
 * bar + count badges. The interactive bits — clicking to another tab and the
 * auto-focus-Approvals-on-new-interrupt effect (a useEffect, doesn't run in SSR) — need
 * a real DOM and are covered by the Playwright e2e.
 *
 * Note: the sessions store always has a current conversation (freshState seeds one), so
 * the panel is always shown — the Sandbox status tab is persistent by design.
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
  it("always shows the panel with a persistent, default-active Sandbox tab", () => {
    const html = render({});
    expect(html).toContain('data-testid="right-panel"');
    expect(html).toContain('data-testid="right-panel-tab-sandbox"');
    // Sandbox is the leftmost, default-active tab -> its content renders on first paint.
    expect(html).toContain('data-testid="sandbox-panel"');
    // The sandbox tab button is the selected one (aria-selected precedes data-testid).
    expect(html).toMatch(/aria-selected="true"[^>]*right-panel-tab-sandbox/);
  });

  it("shows the Queue badge count; approvals badge absent when there are none", () => {
    const html = render({ queuedMessages: [{ id: "q1", text: "hello queued", priority: 0 }] });
    expect(html).toContain('data-testid="right-panel-tab-approvals"');
    expect(html).toContain('data-testid="right-panel-tab-queue"');
    expect(html).toContain('data-testid="right-panel-badge-queue"');
    expect(html).not.toContain('data-testid="right-panel-badge-approvals"');
  });

  it("first paint is the Sandbox tab even with pending approvals (auto-focus is a client effect)", () => {
    const html = render({ interrupts: [interrupt("i1", "approve the deploy?")] });
    // SSR first paint: Sandbox content shows; the interrupt lives in the inactive
    // Approvals tab (the auto-focus effect runs only in the real DOM).
    expect(html).toContain('data-testid="sandbox-panel"');
    expect(html).not.toContain("approve the deploy?");
    // The approvals badge is the RED alert variant (a gate the user must act on).
    expect(html).toContain('data-testid="right-panel-badge-approvals"');
    expect(html).toMatch(/right-panel-badge-approvals"[^>]*data-alert="true"/);
  });
});
