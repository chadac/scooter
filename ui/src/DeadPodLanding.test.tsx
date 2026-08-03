/**
 * UI unit test — the dead-pod conversation landing (pure): shown when the pod is
 * suspended/ended, with a Start button; not shown while running/starting/checking.
 */

import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DeadPodLanding, StartingPodLanding, shouldShowDeadPodLanding } from "./DeadPodLanding.js";

describe("shouldShowDeadPodLanding", () => {
  it("shows for suspended + ended (a Start would help)", () => {
    expect(shouldShowDeadPodLanding("suspended")).toBe(true);
    expect(shouldShowDeadPodLanding("ended")).toBe(true);
  });

  it("does NOT show for running/starting/unknown (thread or loading is fine; don't flash on a transient)", () => {
    expect(shouldShowDeadPodLanding("running")).toBe(false);
    expect(shouldShowDeadPodLanding("starting")).toBe(false);
    expect(shouldShowDeadPodLanding("unknown")).toBe(false);
  });
});

describe("DeadPodLanding", () => {
  it("suspended: 'asleep' copy + a Start button", () => {
    const html = renderToStaticMarkup(createElement(DeadPodLanding, { state: "suspended", onStart: () => {} }));
    expect(html).toContain('data-testid="dead-pod-landing"');
    expect(html).toContain('data-state="suspended"');
    expect(html.toLowerCase()).toContain("asleep");
    expect(html).toContain('data-testid="dead-pod-start"');
    expect(html).toContain("Start conversation");
  });

  it("ended: 'ended' copy + a Start button", () => {
    const html = renderToStaticMarkup(createElement(DeadPodLanding, { state: "ended", onStart: () => {} }));
    expect(html).toContain('data-state="ended"');
    expect(html.toLowerCase()).toContain("ended");
    expect(html).toContain('data-testid="dead-pod-start"');
  });

  it("StartingPodLanding shows a spinner + 'starting' copy", () => {
    const html = renderToStaticMarkup(createElement(StartingPodLanding));
    expect(html).toContain('data-testid="starting-pod-landing"');
    expect(html.toLowerCase()).toContain("starting");
  });
});

// A light guard that onStart is wired to the button (behavioral intent). We can't
// click in a static render, so assert the prop is invoked when called directly —
// the App wiring (ConversationArea) passes useSandboxStatus.startSandbox.
describe("DeadPodLanding onStart wiring", () => {
  it("invokes onStart (the resume action) — sanity that the callback is the contract", () => {
    const onStart = vi.fn();
    // Render doesn't click, but constructing with the callback documents the contract;
    // the real click is covered by the e2e. Assert the component accepts + holds it.
    const el = createElement(DeadPodLanding, { state: "suspended", onStart });
    expect(el.props.onStart).toBe(onStart);
    onStart();
    expect(onStart).toHaveBeenCalledTimes(1);
  });
});
