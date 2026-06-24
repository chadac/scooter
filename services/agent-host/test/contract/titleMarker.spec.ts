/**
 * Tier 1 contract test — title-marker extraction from a streaming message.
 *
 * The agent emits <title>…</title> as its first action; the bridge must extract
 * the title (once) and strip the marker from the displayed text — even when the
 * marker is split arbitrarily across streamed deltas.
 */

import { describe, it, expect } from "vitest";

import { createTitleExtractor } from "../../src/agent/titleMarker.js";

/** Feed a full string as one or more deltas, return concatenated display text +
 *  the title (if any). */
function run(deltas: string[]): { text: string; title?: string } {
  const ex = createTitleExtractor();
  let text = "";
  let title: string | undefined;
  for (const d of deltas) {
    const r = ex.push(d);
    text += r.text;
    if (r.title !== undefined) title = r.title;
  }
  return { text, title };
}

describe("title-marker extraction", () => {
  it("extracts a title and strips the marker (single delta)", () => {
    const r = run(["<title>Refactor the parser</title>Now I'll start."]);
    expect(r.title).toBe("Refactor the parser");
    expect(r.text).toBe("Now I'll start.");
  });

  it("passes plain text through untouched when there's no marker", () => {
    const r = run(["Hello, working on it.", " More text."]);
    expect(r.title).toBeUndefined();
    expect(r.text).toBe("Hello, working on it. More text.");
  });

  it("handles the marker split across many deltas", () => {
    const r = run(["<ti", "tle>Fix ", "the ", "login bug</tit", "le>", "Done thinking."]);
    expect(r.title).toBe("Fix the login bug");
    expect(r.text).toBe("Done thinking.");
  });

  it("handles a marker that opens at the very tail of a delta", () => {
    const r = run(["Some preamble <title>", "My Title</title> tail"]);
    expect(r.title).toBe("My Title");
    expect(r.text).toBe("Some preamble  tail");
  });

  it("trims whitespace inside the title", () => {
    const r = run(["<title>   Spaced Title  </title>rest"]);
    expect(r.title).toBe("Spaced Title");
    expect(r.text).toBe("rest");
  });

  it("reports the title only once even if more text follows", () => {
    const ex = createTitleExtractor();
    const a = ex.push("<title>One</title>hi");
    const b = ex.push(" there");
    expect(a.title).toBe("One");
    expect(b.title).toBeUndefined();
    expect(a.text + b.text).toBe("hi there");
  });

  it("does not leak a partial opening tag that never completes", () => {
    // A lone "<tit" at the end is held back (could be a marker) — it must not be
    // shown as-is mid-stream; here the stream simply ends without completing it.
    const ex = createTitleExtractor();
    const r = ex.push("answer <tit");
    expect(r.text).toBe("answer ");
    expect(r.title).toBeUndefined();
  });
});
