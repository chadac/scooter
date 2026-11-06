// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { typingElsewhere } from "./typingElsewhere";

describe("typingElsewhere", () => {
  const mk = (html: string) => {
    document.body.innerHTML = html;
    return document.getElementById("t");
  };

  it("is true for a text input outside the composer", () => {
    expect(typingElsewhere(mk(`<input id="t" aria-label="Filter folders">`))).toBe(true);
  });
  it("is false inside the composer", () => {
    expect(typingElsewhere(mk(`<div class="aui-composer-root"><textarea id="t"></textarea></div>`))).toBe(false);
  });
  it("is false for buttons, checkboxes and nothing focused", () => {
    expect(typingElsewhere(mk(`<button id="t">x</button>`))).toBe(false);
    expect(typingElsewhere(mk(`<input id="t" type="checkbox">`))).toBe(false);
    expect(typingElsewhere(null)).toBe(false);
  });
});
