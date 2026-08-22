/**
 * Tier 1 — parseLeadingJson (test/support/cluster.ts), the tolerant parse behind curlJson.
 *
 * WHY. Tier-2 tests fetch JSON through a throwaway `kubectl run -i` curl pod, whose captured
 * output can carry a stray line AFTER the payload (attach/teardown warnings) even with unique
 * per-call pod names. That failed the platform smoke with
 *   SyntaxError: Unexpected non-whitespace character after JSON at position 1513 (line 2 column 1)
 * where line 1 was the complete, valid response. The helper parses the LEADING JSON value so an
 * assertion on the payload is immune to appended junk — while a truly malformed payload still
 * throws the original error. Tested here (not in test/cluster/) because it needs no cluster.
 */

import { describe, it, expect } from "vitest";
import { parseLeadingJson } from "../../../../test/support/cluster.js";

describe("parseLeadingJson", () => {
  it("parses clean JSON unchanged", () => {
    expect(parseLeadingJson('[{"id":"a"}]')).toEqual([{ id: "a" }]);
  });
  it("THE FAILURE SHAPE: valid JSON line 1 + junk line 2", () => {
    expect(parseLeadingJson('[{"id":"a"},{"id":"b"}]\nWarning: attach raced teardown')).toEqual([
      { id: "a" }, { id: "b" },
    ]);
  });
  it("two concatenated JSON docs -> the first wins", () => {
    expect(parseLeadingJson('{"id":"first"}\n{"id":"second"}')).toEqual({ id: "first" });
  });
  it("genuinely malformed still throws the original error", () => {
    expect(() => parseLeadingJson("not json at all")).toThrow(SyntaxError);
  });
});
