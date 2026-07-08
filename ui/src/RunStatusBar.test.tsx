/**
 * UI unit test — the Stop button gives IMMEDIATE feedback (the Stop-no-feedback bug).
 *
 * The run's terminal event round-trips through the integrity stream, so without
 * optimistic state the button looks dead between click and that round-trip. The
 * bar reads `cancelState` from context: "stopping" disables the button + shows
 * "Stopping…"; "failed" (the cancel POST errored, or nothing confirmed the stop)
 * shows a re-enabled "Retry stop" so the user is never left in limbo.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RunStatusBar } from "./RunStatusBar.js";
import { InterruptContext, type InterruptContextValue } from "./RuntimeProvider.js";

function render(over: Partial<InterruptContextValue>): string {
  const value = {
    interrupts: [],
    submitResume: async () => {},
    conversationId: "c1",
    baseUrl: "",
    isRunning: true,
    cancel: async () => {},
    cancelState: "idle",
    renderTick: 0,
    ...over,
  } as InterruptContextValue;
  return renderToStaticMarkup(createElement(InterruptContext.Provider, { value }, createElement(RunStatusBar)));
}

describe("RunStatusBar Stop feedback", () => {
  it("renders nothing when no run is active", () => {
    expect(render({ isRunning: false })).toBe("");
  });

  // React renders a boolean `disabled` attribute as the bare `disabled=""` on the
  // element; the className carries literal "disabled:" Tailwind variants, so match
  // the attribute form specifically rather than the substring.
  const buttonDisabled = (html: string) => /<button[^>]*\sdisabled(=""|\s|>)/.test(html);

  it("idle: shows an ENABLED Stop button", () => {
    const html = render({ cancelState: "idle" });
    expect(html).toContain(">Stop<");
    expect(buttonDisabled(html)).toBe(false);
    expect(html).toContain("Scooter is working…");
  });

  it("stopping: DISABLES the button + shows 'Stopping…' (the click is acknowledged)", () => {
    const html = render({ cancelState: "stopping" });
    expect(buttonDisabled(html)).toBe(true);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Stopping…");
    // Must NOT still say plain "Stop" as if nothing happened.
    expect(html).not.toContain(">Stop<");
  });

  it("failed: RE-ENABLES the button as 'Retry stop' + tells the user it didn't land", () => {
    const html = render({ cancelState: "failed" });
    expect(html).toContain("Retry stop");
    expect(buttonDisabled(html)).toBe(false);
    // (the apostrophe is HTML-escaped in static markup, so match up to it)
    expect(html).toContain("the run is still going");
  });
});
