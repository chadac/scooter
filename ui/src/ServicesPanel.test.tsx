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
