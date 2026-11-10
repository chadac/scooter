/**
 * The right-side panel: the Session and Approvals tabs.
 *
 * SSR render, so this covers the structure: the persistent Session tab (leftmost,
 * default-active on first paint) holding the sandbox status and its collapsible
 * sections, the two-tab bar and the count badges. Tab clicks, section toggles and the
 * auto-focus-Approvals effect need a real DOM and are covered by the Playwright e2e.
 * The sessions store always seeds a current conversation, so the panel is always shown.
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
  it("always shows the panel with a persistent, default-active Session tab", () => {
    const html = render({});
    expect(html).toContain('data-testid="right-panel"');
    expect(html).toContain('data-testid="right-panel-tab-session"');
    // Session is the leftmost, default-active tab -> its content renders on first paint.
    expect(html).toContain('data-testid="sandbox-panel"');
    // The session tab button is the selected one (aria-selected precedes data-testid).
    expect(html).toMatch(/aria-selected="true"[^>]*right-panel-tab-session/);
  });

  it("has exactly two tabs, with Services a collapsible section of Session", () => {
    const html = render({});
    const tabs = html.match(/data-testid="right-panel-tab-[a-z]+"/g) ?? [];
    expect(tabs).toEqual(['data-testid="right-panel-tab-session"', 'data-testid="right-panel-tab-approvals"']);
    expect(html).toMatch(/data-testid="right-panel-section-services" data-open="true"/);
    expect(html).toMatch(/right-panel-section-toggle-services" aria-expanded="true"/);
    // No other chats and none can start, so no empty Chats section.
    expect(html).not.toContain('data-testid="right-panel-section-chats"');
  });

  it("has no Queue tab (queued messages render inline in the thread); approvals badge absent when there are none", () => {
    const html = render({ queuedMessages: [{ id: "q1", text: "hello queued", priority: 0 }] });
    expect(html).toContain('data-testid="right-panel-tab-approvals"');
    expect(html).not.toContain('data-testid="right-panel-tab-queue"');
    expect(html).not.toContain("hello queued");
    expect(html).not.toContain('data-testid="right-panel-badge-approvals"');
  });

  it("first paint is the Session tab even with pending approvals (auto-focus is a client effect)", () => {
    const html = render({ interrupts: [interrupt("i1", "approve the deploy?")] });
    // On the SSR first paint the interrupt lives in the inactive Approvals tab.
    expect(html).toContain('data-testid="sandbox-panel"');
    expect(html).not.toContain("approve the deploy?");
    // The approvals badge is the alert variant.
    expect(html).toContain('data-testid="right-panel-badge-approvals"');
    expect(html).toMatch(/right-panel-badge-approvals"[^>]*data-alert="true"/);
  });
});
