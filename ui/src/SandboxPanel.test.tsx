/**
 * UI unit test — the Sandbox status view (pure). Shows the pod state and, when the
 * pod is down (suspended/starting), a Start button; running/ended show no button.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SandboxStatusView } from "./SandboxPanel.js";

const noop = () => {};

describe("SandboxStatusView", () => {
  it("running: shows Running, no Start button", () => {
    const html = renderToStaticMarkup(createElement(SandboxStatusView, { state: "running", onStart: noop }));
    expect(html).toContain('data-state="running"');
    expect(html).toContain("Running");
    expect(html).not.toContain('data-testid="sandbox-start"');
  });

  it("suspended: shows Suspended + a Start button", () => {
    const html = renderToStaticMarkup(createElement(SandboxStatusView, { state: "suspended", onStart: noop }));
    expect(html).toContain('data-state="suspended"');
    expect(html).toContain('data-testid="sandbox-start"');
    expect(html).toContain("Start sandbox");
  });

  it("starting: button is disabled + shows Starting…", () => {
    const html = renderToStaticMarkup(createElement(SandboxStatusView, { state: "starting", onStart: noop }));
    expect(html).toContain('data-state="starting"');
    expect(html).toContain('data-testid="sandbox-start"');
    expect(html).toContain("disabled");
    expect(html).toContain("Starting…");
  });

  it("ended: no Start button (the sandbox is gone)", () => {
    const html = renderToStaticMarkup(createElement(SandboxStatusView, { state: "ended", onStart: noop }));
    expect(html).toContain('data-state="ended"');
    expect(html).not.toContain('data-testid="sandbox-start"');
  });
});
