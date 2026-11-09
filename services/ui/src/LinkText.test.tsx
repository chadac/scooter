/**
 * Contrib link views (`ui.linkView`): the contrib that owns a link's source draws its text,
 * and the app falls back to the plain title for a source without one, a view missing from
 * the build, or a view that throws. The lazy module table is mocked so a view renders
 * synchronously under SSR.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { LinkViewProps } from "./contrib/sdk.js";

const views: Record<string, (p: LinkViewProps) => unknown> = {
  "acme/ui/LinkView.tsx": ({ link }) => createElement("b", { "data-acme": "" }, `acme: ${link.title}`),
  "boom/ui/LinkView.tsx": () => {
    throw new Error("boom");
  },
};
vi.mock("./contribTabs.js", () => ({ lazyContrib: (entry: string) => views[entry] }));

const { loadContribManifest, contribLinkViews } = await import("./contribManifest.js");
const { LinkText } = await import("./LinkText.js");
const { LinkedResourcesPanel } = await import("./LinkedResources.js");

async function serve(doc: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => doc })) as unknown as typeof fetch);
  await loadContribManifest();
}
const render = (source: string, title = "feat: x") =>
  renderToStaticMarkup(createElement(LinkText, { link: { source, resourceType: "change", url: "https://x/1", title } }));

const DOC = {
  linkViews: {
    acme: { entry: "acme/ui/LinkView.tsx" },
    boom: { entry: "boom/ui/LinkView.tsx" },
    gone: { entry: "gone/ui/LinkView.tsx" },
    // Another contrib's module is refused.
    thief: { entry: "acme/ui/LinkView.tsx" },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("contrib link views", () => {
  it("keeps only rows whose entry sits in their own contrib's ui/", async () => {
    await serve(DOC);
    expect(Object.keys(contribLinkViews()).sort()).toEqual(["acme", "boom", "gone"]);
  });

  it("lets the owning contrib draw the link", async () => {
    await serve(DOC);
    expect(render("acme")).toContain("<b data-acme=\"\">acme: feat: x</b>");
  });

  it("shows the plain title with no view, a view missing from the build, or one that throws", async () => {
    await serve(DOC);
    for (const source of ["github", "gone"]) {
      expect(render(source)).toBe('<span class="truncate">feat: x</span>');
    }
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => render("boom")).not.toThrow();
  });

  it("draws nothing extra without a manifest: the app has no per-provider labels", async () => {
    await serve({});
    expect(render("acme")).toBe('<span class="truncate">feat: x</span>');
  });

  it("renders the view inside the Linked panel row", async () => {
    await serve(DOC);
    const html = renderToStaticMarkup(
      createElement(LinkedResourcesPanel, { links: [{ source: "acme", resourceType: "change", url: "https://x/1", title: "t" }] }),
    );
    expect(html).toMatch(/data-testid="linked-resource"[\s\S]*acme: t/);
  });
});
