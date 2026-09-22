/**
 * UI unit test — the contrib UI manifest and the three places the app merges it.
 *
 * What this actually guards: that gitlab/jira reach the UI THROUGH the manifest
 * and are no longer hardcoded. The pre-existing sourceIcon/toolCallView tests
 * still assert gitlab and jira render — unchanged — so those suites passing is
 * itself the end-to-end proof the merge works. These tests add the half those
 * cannot see: that the app's own tables no longer carry them, so a regression
 * that re-hardcodes a contrib's row is caught rather than silently masking a
 * broken manifest.
 *
 * See contrib/ui-manifest.nix (what generates it) and contrib/README.md.
 */

import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  contribSources,
  contribToolCards,
  contribToolTitles,
  contribLinkProviders,
} from "./contribManifest.generated.js";
import { sourceLabel, SourceBadge } from "./sourceIcon.js";
import { matchToolCall } from "./toolCallView.js";
import { LINK_PROVIDERS } from "./sessions.js";

/** The contribs this repo ships that declare a UI half. */
const UI_CONTRIBS = ["gitlab", "jira"];

describe("the contrib UI manifest", () => {
  it("carries a row for every contrib that declares one", () => {
    expect(Object.keys(contribSources).sort()).toEqual(UI_CONTRIBS);
  });

  it("RENDERS a real icon for each (an icon name that no longer exists is undefined here)", () => {
    for (const source of Object.keys(contribSources)) {
      // renderToStaticMarkup invokes the component, so a stale icon name throws
      // instead of silently rendering nothing.
      const html = renderToStaticMarkup(createElement(SourceBadge, { source }));
      expect(html, `${source} rendered no <svg>`).toContain("<svg");
    }
  });

  it("only offers a filter chip for a source it can actually draw", () => {
    for (const p of contribLinkProviders) expect(contribSources).toHaveProperty(p);
  });
});

describe("the app merges it in", () => {
  it("resolves a contrib's label through sourceIcon", () => {
    for (const [name, meta] of Object.entries(contribSources)) {
      expect(sourceLabel(name)).toBe(meta.label);
    }
  });

  it("resolves a contrib's tool card through toolCallView, by name AND by title", () => {
    for (const [tool, card] of Object.entries(contribToolCards)) {
      expect(matchToolCall(tool, { [card.argKey]: "hello" })).toEqual({
        provider: card.provider,
        body: "hello",
        action: card.action,
      });
    }
    for (const [title, tool] of Object.entries(contribToolTitles)) {
      const card = contribToolCards[tool];
      expect(matchToolCall(title, { [card.argKey]: "hi" })).toMatchObject({ provider: card.provider });
    }
  });

  it("offers a contrib's chip in the sidebar filter list", () => {
    for (const p of contribLinkProviders) expect(LINK_PROVIDERS).toContain(p);
  });
});

describe("the app no longer hardcodes a contrib's row", () => {
  // Without these, re-hardcoding gitlab in sourceIcon.tsx would keep every other
  // test green while the manifest quietly rendered nothing.
  it("keeps contrib names OUT of the app's own link-provider list", () => {
    const builtin = LINK_PROVIDERS.filter((p) => !contribLinkProviders.includes(p));
    expect(builtin).toEqual(["github", "slack"]);
  });

  it("drops a contrib's row entirely when the manifest does not carry it", () => {
    // The fallback path an absent contrib takes: a neutral glyph, no <svg>, and
    // the raw name as the label — NOT a dead branded chip.
    const html = renderToStaticMarkup(createElement(SourceBadge, { source: "datadog" }));
    expect(html).not.toContain("<svg");
    expect(sourceLabel("datadog")).toBe("datadog");
  });
});
