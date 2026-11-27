// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { inComposer, typingElsewhere } from "./typingElsewhere";

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
  it("is true anywhere in an open popover or menu", () => {
    expect(typingElsewhere(mk(`<div role="dialog"><button id="t">x</button></div>`))).toBe(true);
    expect(typingElsewhere(mk(`<div role="menu"><div id="t" tabindex="-1">x</div></div>`))).toBe(true);
  });
  it("is false for buttons, checkboxes and nothing focused", () => {
    expect(typingElsewhere(mk(`<button id="t">x</button>`))).toBe(false);
    expect(typingElsewhere(mk(`<input id="t" type="checkbox">`))).toBe(false);
    expect(typingElsewhere(null)).toBe(false);
  });
});

describe("inComposer", () => {
  const mk = (html: string) => {
    document.body.innerHTML = html;
    return document.getElementById("t");
  };

  it("is true for the composer's input", () => {
    expect(inComposer(mk(`<div class="aui-composer-root"><textarea id="t"></textarea></div>`))).toBe(true);
  });
  it("is false for a composer button, a textarea elsewhere and nothing focused", () => {
    expect(inComposer(mk(`<div class="aui-composer-root"><button id="t">Send</button></div>`))).toBe(false);
    expect(inComposer(mk(`<textarea id="t"></textarea>`))).toBe(false);
    expect(inComposer(null)).toBe(false);
  });
});
