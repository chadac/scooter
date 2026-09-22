/**
 * UI unit test — tier 2 of the contrib UI surface: a contrib contributing a
 * right-panel TAB.
 *
 * Two halves, deliberately tested differently:
 *
 *  1. The MECHANISM, against a fake manifest (vi.mock). The real manifest holds
 *     whatever contribs this repo happens to ship, so asserting behaviour
 *     through it would make these tests change every time a contrib is added.
 *     The fake pins the contract instead: a shown panel gets a tab, a hidden one
 *     gets nothing, and the body renders when its tab is active.
 *  2. The real SHARES panel, imported directly from the generated overlay, so a
 *     panel that no longer satisfies ContribPanel — or that drifted from the
 *     contrib source — fails here rather than at deploy time.
 *
 * SSR render, matching RightPanel.test.tsx's house style.
 */

import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Hoisted: the mock has to be in place before RightPanel imports the manifest.
const fakePanels = vi.hoisted(() => [
  {
    id: "widgets",
    title: "Widgets",
    usePanel: () => ({ show: true, count: 3, body: createElement("p", { "data-testid": "widgets-body" }, "hi") }),
  },
  {
    id: "hidden",
    title: "Hidden",
    usePanel: () => ({ show: false, count: 0, body: createElement("p", null, "never") }),
  },
]);

vi.mock("./contribPanels.generated.js", () => ({ contribPanels: fakePanels }));

// Static imports are fine: vi.mock is hoisted above them.
import { RightPanel } from "./RightPanel.js";
import { InterruptContext, type InterruptContextValue } from "./RuntimeProvider.js";

function render(): string {
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
  } as unknown as InterruptContextValue;
  return renderToStaticMarkup(createElement(InterruptContext.Provider, { value }, createElement(RightPanel)));
}

describe("a contrib's right-panel tab", () => {
  it("adds a tab with its title and count", () => {
    const html = render();
    expect(html).toContain('data-testid="right-panel-tab-widgets"');
    expect(html).toContain("Widgets");
  });

  it("renders NOTHING for a panel that reports show:false", () => {
    // The point of `show`: a feature whose backend isn't wired in this
    // deployment hides its tab rather than offering an empty one.
    const html = render();
    expect(html).not.toContain('data-testid="right-panel-tab-hidden"');
    expect(html).not.toContain("Hidden");
  });

  it("keeps the app's own tabs, with contrib tabs after them", () => {
    const html = render();
    for (const t of ["sandbox", "approvals", "queue"]) {
      expect(html).toContain(`data-testid="right-panel-tab-${t}"`);
    }
    expect(html.indexOf("right-panel-tab-queue")).toBeLessThan(html.indexOf("right-panel-tab-widgets"));
  });

  it("does not render a contrib body while another tab is active", () => {
    // Sandbox is the default tab on first paint, so the contrib body must not be
    // in the markup — `body` is built every render but only mounted when active.
    expect(render()).not.toContain('data-testid="widgets-body"');
  });
});

describe("the shares panel (the real contrib, via the generated overlay)", () => {
  it("is the panel the manifest ships, and satisfies ContribPanel", async () => {
    const real = await vi.importActual<typeof import("./contribPanels.generated.js")>("./contribPanels.generated.js");
    const shares = real.contribPanels.find((p) => p.id === "shares");
    expect(shares, "the shares contrib should contribute a panel").toBeDefined();
    expect(shares!.title).toBe("Shares");
    expect(typeof shares!.usePanel).toBe("function");
  });

  it("is the contrib's own source, overlaid into the UI tree", async () => {
    // Imports the copied panel directly: proves the overlay lands where the
    // manifest expects it and that the file compiles against @scooter/ui-kit.
    // A panel left behind by a removed contrib would still import cleanly, which
    // is what `just contrib-ui-check` catches instead.
    const panel = await import("./contrib/shares/SharesPanel.js");
    expect(typeof panel.usePanel).toBe("function");
  });
});
