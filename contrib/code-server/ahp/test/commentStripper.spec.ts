import { describe, expect, it } from "vitest";
import { CommentStripper } from "../src/commentStripper.js";

const strip = (...chunks: string[]) => {
  const s = new CommentStripper();
  return chunks.map((c) => s.push(c)).join("") + s.end();
};

describe("CommentStripper", () => {
  it("drops a comment whose markers are split across chunks", () => {
    expect(strip("a <", "!", "-- x -", "-", "> b")).toBe("a  b");
  });
  it("keeps text that only resembles a marker", () => {
    expect(strip("a <!", "b -> c")).toBe("a <!b -> c");
  });
  it("hides an unclosed comment and keeps a lone close marker", () => {
    expect(strip("a --> b <!-- never closed")).toBe("a --> b ");
  });
});
