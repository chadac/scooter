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

describe("SandboxPanelView — rescan services", () => {
  it("offers Rescan even when NO services are declared", () => {
    // This is the case that matters: the agent just ran `scooter-rebuild` to add
    // the first service, and the panel still says "no services". Hiding the button
    // here would leave the user with no way to look again.
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        onRescanServices: noop,
      }),
    );
    expect(html).toContain('data-testid="sandbox-no-services"');
    expect(html).toContain('data-testid="sandbox-rescan-services"');
  });

  it("offers Rescan alongside an existing list", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        services: [{ name: "marimo", displayName: "marimo", url: "/c/x/marimo/", running: true }],
        onRescanServices: noop,
      }),
    );
    expect(html).toContain('data-testid="sandbox-rescan-services"');
  });

  it("disables the button while a rescan is in flight", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        onRescanServices: noop,
        rescanning: true,
      }),
    );
    expect(html).toContain("Rescanning");
    expect(html).toMatch(/data-testid="sandbox-rescan-services"[^>]*disabled/);
  });

  it("omits the button when no handler is wired", () => {
    const html = renderToStaticMarkup(createElement(SandboxPanelView, { ...base, state: "running" }));
    expect(html).not.toContain('data-testid="sandbox-rescan-services"');
  });
});

describe("SandboxPanelView — size picker", () => {
  const sizes = {
    small: { cpu: "1", memory: "2Gi" },
    medium: { cpu: "2", memory: "4Gi" },
    "gpu-small": { cpu: "4", memory: "16Gi", gpu: 1 },
  };

  it("renders the deployment's presets, GPU ones included", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, { ...base, state: "running", sizes, onSelectSize: noop }),
    );
    expect(html).toContain('data-testid="sandbox-size-select"');
    expect(html).toContain("medium — 2 CPU · 4Gi");
    expect(html).toContain("gpu-small — 4 CPU · 16Gi · 1 GPU");
  });

  it("selects the preset matching the CURRENT allotment", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        sizes,
        onSelectSize: noop,
        resources: { requests: { cpu: "1", memory: "2Gi" }, limits: { cpu: "1", memory: "2Gi" } },
      }),
    );
    // renderToStaticMarkup puts `selected` on the chosen <option>.
    expect(html).toMatch(/<option value="small" selected="">/);
  });

  it("does NOT match a CPU preset when the allotment carries a GPU", () => {
    // gpu-small and a hypothetical cpu-only 4/16Gi differ ONLY by the gpu count;
    // ignoring gpu here would highlight the wrong preset and a user "re-picking" it
    // would silently drop their GPU.
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        sizes: { ...sizes, big: { cpu: "4", memory: "16Gi" } },
        onSelectSize: noop,
        resources: { limits: { cpu: "4", memory: "16Gi", gpu: 1 } },
      }),
    );
    expect(html).toMatch(/<option value="gpu-small" selected="">/);
    expect(html).not.toMatch(/<option value="big" selected="">/);
  });

  it("shows Custom when the applied size matches no preset (agent-set raw values)", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        sizes,
        onSelectSize: noop,
        resources: { limits: { cpu: "7", memory: "13Gi" } },
      }),
    );
    expect(html).toContain("Custom");
  });

  it("surfaces a rejection inline instead of silently reverting", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        sizes,
        onSelectSize: noop,
        sizeError: 'Unknown size preset "huge". Available: small, medium',
      }),
    );
    expect(html).toContain('data-testid="sandbox-size-error"');
    expect(html).toContain("Unknown size preset");
  });

  it("says a recorded size waits for the next restart", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        sizes,
        onSelectSize: noop,
        sizePendingRestart: true,
      }),
    );
    expect(html).toContain('data-testid="sandbox-size-pending"');
  });

  it("shows the selected preset's hint — the steer a first-time user needs", () => {
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        sizes: { ...sizes, medium: { ...sizes.medium, hint: "Builds and test suites." } },
        onSelectSize: noop,
        resources: { limits: { cpu: "2", memory: "4Gi" } },
      }),
    );
    expect(html).toContain('data-testid="sandbox-size-hint"');
    expect(html).toContain("Builds and test suites.");
    // Under the select, NOT inside an option label (which would truncate the numbers).
    expect(html).not.toMatch(/<option[^>]*>[^<]*Builds and test suites/);
  });

  it("keeps the hint line out of the way when there is nothing to say", () => {
    // Three quiet cases: the preset has no hint, the deployment set none at all, and
    // "Custom" (no preset selected). An empty muted line would just be noise.
    for (const props of [
      { sizes: { ...sizes, medium: { ...sizes.medium, hint: "" } }, resources: { limits: { cpu: "2", memory: "4Gi" } } },
      { sizes, resources: { limits: { cpu: "2", memory: "4Gi" } } },
      {
        sizes: { ...sizes, medium: { ...sizes.medium, hint: "Builds and test suites." } },
        resources: { limits: { cpu: "7", memory: "13Gi" } },
      },
    ]) {
      const html = renderToStaticMarkup(
        createElement(SandboxPanelView, { ...base, state: "running", onSelectSize: noop, ...props }),
      );
      expect(html).not.toContain('data-testid="sandbox-size-hint"');
    }
  });

  it("shows the hint alongside the restart note, not instead of it", () => {
    // They answer different questions ("should I pick this?" vs "did it apply
    // yet?"), so one must not suppress the other.
    const html = renderToStaticMarkup(
      createElement(SandboxPanelView, {
        ...base,
        state: "running",
        sizes: { ...sizes, medium: { ...sizes.medium, hint: "Builds and test suites." } },
        onSelectSize: noop,
        resources: { limits: { cpu: "2", memory: "4Gi" } },
        sizePendingRestart: true,
      }),
    );
    expect(html).toContain('data-testid="sandbox-size-hint"');
    expect(html).toContain('data-testid="sandbox-size-pending"');
  });

  it("hides the picker when the deployment configured no presets, or no write path", () => {
    for (const props of [
      { sizes: {}, onSelectSize: noop },
      { sizes, onSelectSize: undefined }, // read-only (no broker)
    ]) {
      const html = renderToStaticMarkup(
        createElement(SandboxPanelView, { ...base, state: "running", ...props }),
      );
      expect(html).not.toContain('data-testid="sandbox-size-select"');
    }
  });
});
