/**
 * UI unit test — the RUNTIME contrib manifest loader and the three places the app
 * merges it.
 *
 * What this guards: that a deployment's contrib rows reach the UI over the wire
 * (so changing the contrib set needs no UI recompile), that a missing/broken
 * manifest can never take the app down with it, and that no contrib row is
 * hardcoded in the app's own tables — a regression that re-hardcodes gitlab would
 * otherwise keep every other suite green while the loader quietly did nothing.
 *
 * The loader is driven through a stubbed `fetch`, i.e. the real code path,
 * because the failure modes worth testing (404, timeout, malformed body) only
 * exist there. Module state is per test FILE in vitest, and every test below
 * establishes its own by loading first.
 *
 * See contrib/ui-manifest.nix (what generates the document) and contrib/README.md.
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  loadContribManifest,
  contribSources,
  contribToolCards,
  contribToolTitles,
  contribLinkProviders,
} from "./contribManifest.js";
import { sourceLabel, SourceBadge } from "./sourceIcon.js";
import { matchToolCall } from "./toolCallView.js";
import { linkProviders } from "./sessions.js";

/** One contrib's worth of the served document, shaped exactly as contrib/ui-manifest.nix emits it. */
const GITLAB_PATH = "M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 00-.867 0L16.418 9.45H7.582L4.919 1.263a.455.455 0 00-.867 0z";
const DOC = {
  sources: {
    gitlab: {
      label: "GitLab",
      color: "#FC6D26",
      linkProvider: true,
      icon: { viewBox: "0 0 24 24", path: GITLAB_PATH },
    },
  },
  toolCards: { gitlab_comment: { provider: "gitlab", argKey: "body", action: "commented on GitLab" } },
  toolTitles: { "comment on the gitlab mr": "gitlab_comment" },
  linkProviders: ["gitlab"],
};

/** Stub the global fetch the loader calls. */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<unknown>) {
  vi.stubGlobal("fetch", vi.fn(impl) as unknown as typeof fetch);
}

/** Serve a 200 with `doc` as the body. */
const serve = (doc: unknown) => stubFetch(async () => ({ ok: true, json: async () => doc }));

/** The route a deployment without contribs has: nothing there. */
const serve404 = () => stubFetch(async () => ({ ok: false, status: 404, json: async () => ({}) }));

const render = (source: string) => renderToStaticMarkup(createElement(SourceBadge, { source }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("loading the manifest", () => {
  it("fetches the same-origin route, uncached, and populates every getter", async () => {
    serve(DOC);
    await loadContribManifest();

    expect(fetch).toHaveBeenCalledWith("/contrib/manifest.json", expect.objectContaining({ cache: "no-store" }));
    expect(contribSources()).toHaveProperty("gitlab.label", "GitLab");
    expect(contribSources().gitlab.icon).toEqual({ viewBox: "0 0 24 24", path: GITLAB_PATH });
    expect(contribToolCards()).toHaveProperty("gitlab_comment.action", "commented on GitLab");
    expect(contribToolTitles()).toEqual({ "comment on the gitlab mr": "gitlab_comment" });
    expect(contribLinkProviders()).toEqual(["gitlab"]);
  });

  it("accepts a document missing every key (a deployment with no contribs)", async () => {
    serve({});
    await loadContribManifest();
    expect(contribSources()).toEqual({});
    expect(contribToolCards()).toEqual({});
    expect(contribToolTitles()).toEqual({});
    expect(contribLinkProviders()).toEqual([]);
  });

  it("drops only the rows that are malformed, keeping the rest of the document", async () => {
    serve({
      sources: {
        gitlab: DOC.sources.gitlab,
        noIcon: { label: "No Icon", color: "#000" },
        halfIcon: { label: "Half", color: "#000", icon: { viewBox: "0 0 24 24" } },
        noLabel: { color: "#000", icon: { viewBox: "0 0 24 24", path: "M0 0" } },
        notAnObject: "nope",
      },
      toolCards: {
        gitlab_comment: DOC.toolCards.gitlab_comment,
        broken: { provider: "gitlab", action: "did a thing" }, // no argKey
      },
      // A chip for a source that failed validation is the dead chip this feature
      // removes, so it must not survive its row.
      linkProviders: ["gitlab", "noIcon", 7],
    });
    await loadContribManifest();

    expect(Object.keys(contribSources())).toEqual(["gitlab"]);
    expect(Object.keys(contribToolCards())).toEqual(["gitlab_comment"]);
    expect(contribLinkProviders()).toEqual(["gitlab"]);
    // The surviving row still works end to end.
    expect(sourceLabel("gitlab")).toBe("GitLab");
    expect(sourceLabel("noIcon")).toBe("noIcon");
  });
});

describe("a manifest the app cannot read leaves it on its built-ins", () => {
  /** Every getter empty, and the app's own sources still intact. */
  const expectBuiltinsOnly = () => {
    expect(contribSources()).toEqual({});
    expect(contribToolCards()).toEqual({});
    expect(contribLinkProviders()).toEqual([]);
    expect(linkProviders()).toEqual(["github", "slack"]);
    expect(sourceLabel("github")).toBe("GitHub");
    expect(render("github")).toContain("<svg");
    expect(matchToolCall("Respond in the Slack thread", { text: "hi" })).toMatchObject({ provider: "slack" });
  };

  it("a 404 (no contribs deployed)", async () => {
    serve404();
    await expect(loadContribManifest()).resolves.toBeUndefined();
    expectBuiltinsOnly();
  });

  it("a network error", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(loadContribManifest()).resolves.toBeUndefined();
    expectBuiltinsOnly();
  });

  it("a body that is not JSON", async () => {
    stubFetch(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }));
    await expect(loadContribManifest()).resolves.toBeUndefined();
    expectBuiltinsOnly();
  });

  it("a JSON document of the wrong shape entirely", async () => {
    serve(["not", "an", "object"]);
    await loadContribManifest();
    expectBuiltinsOnly();
  });

  it("a hung fetch — the timeout is what makes main.tsx safe to block on", async () => {
    vi.useFakeTimers();
    stubFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const load = loadContribManifest();
    // Before the load resolves the getters are empty rather than undefined.
    expect(contribSources()).toEqual({});
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(load).resolves.toBeUndefined();
    expectBuiltinsOnly();
  });
});

describe("the app merges a loaded manifest in", () => {
  it("resolves a contrib's label and DRAWS its icon through sourceIcon", async () => {
    serve(DOC);
    await loadContribManifest();

    expect(sourceLabel("gitlab")).toBe("GitLab");
    const html = render("gitlab");
    expect(html).toContain("source-icon");
    expect(html).toContain("<svg"); // the row's icon data, not a bundled component
    expect(html).toContain(GITLAB_PATH);
    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain("#FC6D26");
  });

  it("resolves a contrib's tool card through toolCallView, by name AND by title", async () => {
    serve(DOC);
    await loadContribManifest();

    expect(matchToolCall("Scooter-env: Gitlab Comment", { body: "nit: rename" })).toEqual({
      provider: "gitlab",
      body: "nit: rename",
      action: "commented on GitLab",
    });
    expect(matchToolCall("Comment on the GitLab MR", { body: "hi" })).toMatchObject({ provider: "gitlab" });
  });

  it("offers a contrib's chip in the sidebar filter list, after the app's own", async () => {
    serve(DOC);
    await loadContribManifest();
    expect(linkProviders()).toEqual(["github", "slack", "gitlab"]);
  });
});

describe("the app no longer hardcodes a contrib's row", () => {
  it("keeps contrib names OUT of the app's own tables", async () => {
    serve404();
    await loadContribManifest();
    // With nothing served, what remains IS the app's own list.
    expect(linkProviders()).toEqual(["github", "slack"]);
    expect(matchToolCall("Comment on the GitLab MR", { body: "x" })).toBeNull();
  });

  it("drops a contrib's row entirely when the manifest does not carry it", async () => {
    serve404();
    await loadContribManifest();
    // The fallback path an absent contrib takes: a neutral glyph, no <svg>, and
    // the raw name as the label — NOT a dead branded chip.
    expect(render("gitlab")).not.toContain("<svg");
    expect(sourceLabel("gitlab")).toBe("gitlab");
  });

  it("still falls back for a source nobody declares", async () => {
    serve(DOC);
    await loadContribManifest();
    expect(render("datadog")).not.toContain("<svg");
    expect(sourceLabel("datadog")).toBe("datadog");
  });
});
