/**
 * Unit test — parseSystemMessage: the discriminator + parser for a spliced-in
 * SYSTEM event (rendered inline in the thread as a collapsed chip). A message is a
 * system event iff its id starts with `sys:` AND its text starts with the marker;
 * the source is the first line, the body is the rest.
 */

import { describe, it, expect } from "vitest";

import { parseSystemMessage, SYSTEM_MSG_MARKER } from "./RuntimeProvider.js";

describe("parseSystemMessage", () => {
  it("parses a well-formed system message into {source, text}", () => {
    const text = `${SYSTEM_MSG_MARKER}github\nPR #4 was labeled\nsecond line`;
    expect(parseSystemMessage("sys:s1", text)).toEqual({
      source: "github",
      text: "PR #4 was labeled\nsecond line",
    });
  });

  it("handles a source with no body (source-only)", () => {
    expect(parseSystemMessage("sys:s1", `${SYSTEM_MSG_MARKER}scheduler`)).toEqual({
      source: "scheduler",
      text: "",
    });
  });

  it("returns null for a normal assistant message (no sys: id)", () => {
    expect(parseSystemMessage("msg-1", `${SYSTEM_MSG_MARKER}github\nx`)).toBeNull();
  });

  it("returns null when the id is sys: but the marker is absent (defense in depth)", () => {
    expect(parseSystemMessage("sys:s1", "just some assistant text")).toBeNull();
  });

  it("returns null for undefined id/text", () => {
    expect(parseSystemMessage(undefined, undefined)).toBeNull();
  });
});
