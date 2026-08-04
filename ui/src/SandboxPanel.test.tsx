/**
 * UI unit test — the Sandbox panel view (pure): pod status + (when running) the web
 * services, or a Start prompt when the pod is down.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SandboxPanelView } from "./SandboxPanel.js";

const noop = () => {};
const base = { services: [], busy: {}, onStartSandbox: noop, onStartService: noop, onStopService: noop };

describe("SandboxPanelView", () => {
  it("running: shows Running, no Start-sandbox button", () => {
    const html = renderToStaticMarkup(createElement(SandboxPanelView, { ...base, state: "running" }));
    expect(html).toContain('data-state="running"');
    expect(html).not.toContain('data-testid="sandbox-start"');
  });

  it("running with services: lists them (start/stop rows)", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        services: [
          { name: "marimo", displayName: "marimo", url: "/c/x/marimo/", running: true },
          { name: "vscode", displayName: "VS Code", url: "/c/x/vscode/", running: false },
        ],
      }),
    );
    expect(html).toContain("service-list");
    expect(html).toContain("service-stop"); // marimo running
    expect(html).toContain("service-start"); // vscode stopped
  });

  it("suspended: shows Suspended + a Start-sandbox button, no service list", () => {
    const html = renderToStaticMarkup(createElement(SandboxPanelView, { ...base, state: "suspended" }));
    expect(html).toContain('data-state="suspended"');
    expect(html).toContain('data-testid="sandbox-start"');
    expect(html).toContain("Start sandbox");
    expect(html).not.toContain("service-list");
  });

  it("starting: the Start button is disabled + shows Starting…", () => {
    const html = renderToStaticMarkup(createElement(SandboxPanelView, { ...base, state: "starting" }));
    expect(html).toContain('data-state="starting"');
    expect(html).toContain("disabled");
    expect(html).toContain("Starting…");
  });

  it("ended: no Start button", () => {
    const html = renderToStaticMarkup(createElement(SandboxPanelView, { ...base, state: "ended" }));
    expect(html).toContain('data-state="ended"');
    expect(html).not.toContain('data-testid="sandbox-start"');
  });

  it("shows the owner when the conversation is owned", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, { ...base, state: "running", owner: "alice@x.io" }),
    );
    expect(html).toContain('data-testid="sandbox-owner"');
    expect(html).toContain("alice@x.io");
  });

  it("hides the owner field when unowned (no meaningless blank)", () => {
    for (const owner of [undefined, null, ""]) {
      const html = renderToStaticMarkup(
        createElement(SandboxPanelView, { ...base, state: "running", owner }),
      );
      expect(html).not.toContain('data-testid="sandbox-owner"');
    }
  });

  it("shows the resource allotment (requests + limits) when present", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "4Gi" } },
      }),
    );
    expect(html).toContain('data-testid="sandbox-resources"');
    expect(html).toContain("500m CPU");
    expect(html).toContain("1Gi"); // requested memory
    expect(html).toContain("4Gi"); // limit memory
  });

  it("shows resources even while SUSPENDED (the size applies to the next pod)", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "suspended",
        resources: { requests: { cpu: "2", memory: "2Gi", gpu: 1 } },
      }),
    );
    expect(html).toContain('data-testid="sandbox-resources"');
    expect(html).toContain("2 CPU");
    expect(html).toContain("1 GPU");
  });

  it("hides the resources section when absent or all-empty (fake mode / no broker)", () => {
    for (const resources of [undefined, null, {}, { requests: {}, limits: {} }] as const) {
      const html = renderToStaticMarkup(
        createElement(SandboxPanelView, { ...base, state: "running", resources }),
      );
      expect(html).not.toContain('data-testid="sandbox-resources"');
    }
  });
});
