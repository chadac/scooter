/**
 * UI unit test — ServiceRows (the web-services list used by the Sandbox tab): a running
 * service shows Open + Stop, a stopped one shows Start.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ServiceRows } from "./ServicesPanel.js";

const noop = () => {};

describe("ServiceRows", () => {
  it("a running service shows Open AND Stop; a stopped one shows Start", () => {
    const html = renderToStaticMarkup(
      createElement(ServiceRows, {
        services: [
          { name: "marimo", displayName: "marimo", url: "/c/x/marimo/", running: true },
          { name: "vscode", displayName: "VS Code", url: "/c/x/vscode/", running: false },
        ],
        starting: {},
        onStart: noop,
        onStop: noop,
      }),
    );
    expect(html).toContain("service-open"); // marimo running → Open
    expect(html).toContain("service-stop"); // marimo running → Stop
    expect(html).toContain("service-start"); // vscode stopped → Start
    expect(html).toContain('data-running="true"');
    expect(html).toContain('data-running="false"');
  });

  it("warns on a service that declares more than the sandbox caps at", () => {
    const html = renderToStaticMarkup(
      createElement(ServiceRows, {
        services: [
          {
            name: "marimo",
            displayName: "marimo",
            url: "/c/x/marimo/",
            running: false,
            fitShort: "Needs 8Gi memory",
            fit: "marimo declares it needs 8Gi memory (this sandbox caps at 4Gi). It will still start, but may be throttled or OOM-killed — consider a larger sandbox size.",
          },
        ],
        starting: {},
        onStart: noop,
      }),
    );
    expect(html).toContain('data-testid="service-fit"');
    expect(html).toContain("Needs 8Gi memory");
    // The full sentence rides along as the tooltip; the card is too narrow for it.
    expect(html).toContain("may be throttled or OOM-killed");
    // Advisory only — it must not gate the control.
    expect(html).toContain("service-start");
    expect(html).not.toMatch(/data-testid="service-start"[^>]*disabled/);
  });

  it("stays silent when the service fits, or when nothing was declared", () => {
    const html = renderToStaticMarkup(
      createElement(ServiceRows, {
        services: [{ name: "marimo", displayName: "marimo", url: "/c/x/marimo/", running: true }],
        starting: {},
        onStart: noop,
      }),
    );
    expect(html).not.toContain('data-testid="service-fit"');
  });

  it("a service mid-action shows a disabled control", () => {
    const html = renderToStaticMarkup(
      createElement(ServiceRows, {
        services: [{ name: "marimo", displayName: "marimo", url: "/c/x/marimo/", running: false }],
        starting: { marimo: true },
        onStart: noop,
      }),
    );
    expect(html).toContain("Starting…");
    expect(html).toContain("disabled");
  });
});
