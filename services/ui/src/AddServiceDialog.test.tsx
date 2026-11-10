/** The Add service form: what it accepts, and the request it sends Scooter. */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { addServiceError, addServicePrompt, type AddServiceForm } from "./AddServiceDialog.js";
import { SandboxPanelView } from "./SandboxPanel.js";

const form = (over: Partial<AddServiceForm> = {}): AddServiceForm => ({
  name: "dashboard",
  description: "A Streamlit dashboard for app.py",
  ...over,
});

describe("addServiceError", () => {
  it("accepts a slug name", () => {
    expect(addServiceError(form({ name: "my-app2" }), [])).toBeNull();
  });

  it("rejects a name that is not a slug, or already declared", () => {
    expect(addServiceError(form({ name: "My App" }), [])).toMatch(/lowercase/);
    expect(addServiceError(form({ name: "1app" }), [])).toMatch(/lowercase/);
    expect(addServiceError(form(), ["dashboard"])).toMatch(/already exists/);
  });
});

describe("addServicePrompt", () => {
  it("names the service, describes it and says which option to declare", () => {
    const p = addServicePrompt(form());
    expect(p).toContain("- Name: `dashboard`");
    expect(p).toContain("- Description: A Streamlit dashboard for app.py");
    expect(p).toContain("`webServices.dashboard`");
    expect(p).toContain("send me the link");
  });
});

describe("the Services panel's Add row", () => {
  const view = (onRequestService?: (p: string) => void) =>
    renderToStaticMarkup(
      createElement(SandboxPanelView, {
        state: "running",
        services: [],
        busy: {},
        onStartSandbox: () => {},
        onStartService: () => {},
        onStopService: () => {},
        onRequestService,
      }),
    );

  it("shows only when the panel can send a request", () => {
    expect(view(() => {})).toContain('data-testid="service-add"');
    expect(view()).not.toContain('data-testid="service-add"');
  });
});
