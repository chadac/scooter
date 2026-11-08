// A syntax module keeps its declared shape and own elements.

import { describe, expect, it, vi } from "vitest";

import { acceptSyntax } from "./contribSyntax.js";

const plugin = () => undefined;
const C = () => null;

describe("acceptSyntax", () => {
  it("keeps the plugins and the contrib's own elements", () => {
    const got = acceptSyntax("math", { default: { remarkPlugins: [plugin], components: { "math-inline": C } } });
    expect(got.remarkPlugins).toEqual([plugin]);
    expect(Object.keys(got.components)).toEqual(["math-inline"]);
  });

  it("drops components outside the contrib's prefix, so links and images stay the app's", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const got = acceptSyntax("math", { default: { components: { a: C, img: C, "other-x": C, "math-x": C } } });
    expect(Object.keys(got.components)).toEqual(["math-x"]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it("is empty for a module without a usable default export", () => {
    for (const mod of [null, {}, { default: 3 }, { default: { remarkPlugins: "x" } }]) {
      expect(acceptSyntax("math", mod)).toEqual({ remarkPlugins: [], components: {} });
    }
  });
});
