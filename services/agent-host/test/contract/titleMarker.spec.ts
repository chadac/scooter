/**
 * Title-marker extraction from a streaming message: the agent emits <title>…</title>
 * first, and the bridge extracts the title once and strips the marker from the
 * displayed text even when it is split across streamed deltas.
 */

import { describe, it, expect } from "vitest";

import { createTitleExtractor } from "../../src/agent/titleMarker.js";

/** Feed deltas through an extractor, returning the concatenated display text and the title. */
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
    // A lone "<tit" at the end is held back as a possible marker.
    const ex = createTitleExtractor();
    const r = ex.push("answer <tit");
    expect(r.text).toBe("answer ");
    expect(r.title).toBeUndefined();
  });

  // Regression: prose `<title>` swallowed every later reply.
  it("gives back prose that mentions <title> instead of swallowing the rest", () => {
    const r = run([
      "the fixed title \"Session\", which blocks the agent's `",
      "<title>` marker from naming it.\n\nNext I'll fix the router.",
    ]);
    expect(r.title).toBeUndefined();
    expect(r.text).toBe(
      "the fixed title \"Session\", which blocks the agent's `<title>` marker from naming it.\n\nNext I'll fix the router.",
    );
  });

  it("abandons a title that runs past the length cap", () => {
    const long = "x".repeat(250);
    const r = run(["<title>", long, " and more"]);
    expect(r.title).toBeUndefined();
    expect(r.text).toBe(`<title>${long} and more`);
  });

  it("treats a closed but multi-line 'title' as text", () => {
    const r = run(["<title>a\nb</title> rest"]);
    expect(r.title).toBeUndefined();
    expect(r.text).toBe("<title>a\nb</title> rest");
  });

  it("matches only the first title; later tags are text", () => {
    const r = run(["<title>First</title>ok. ", "Mention <title>Second</title> here"]);
    expect(r.title).toBe("First");
    expect(r.text).toBe("ok. Mention <title>Second</title> here");
  });

  it("flush releases an unclosed title and a held partial tag", () => {
    const ex = createTitleExtractor();
    expect(ex.push("see the `<title>` marker").text).toBe("see the `");
    const f = ex.flush();
    expect(f.abandoned).toBe(true);
    expect(f.text).toBe("<title>` marker");
    // The next message starts clean.
    expect(ex.push("Next reply.").text).toBe("Next reply.");

    const ex2 = createTitleExtractor();
    expect(ex2.push("answer <tit").text).toBe("answer ");
    expect(ex2.flush()).toEqual({ text: "<tit", abandoned: false });
  });
});
