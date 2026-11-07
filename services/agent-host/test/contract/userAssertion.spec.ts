/**
 * The router's user assertion rides with the approver to the broker, as a header and
 * never in the JSON body, so the broker can check the approver the agent-host names.
 */

import { describe, it, expect } from "vitest";

import { USER_ASSERTION_HEADER, approverForBroker, userAssertionOf } from "../../src/bridge.js";

describe("user assertion relay", () => {
  it("reads the router's header", () => {
    expect(userAssertionOf({ headers: { [USER_ASSERTION_HEADER]: " tok " } })).toBe("tok");
    expect(userAssertionOf({ headers: { [USER_ASSERTION_HEADER]: ["a", "b"] } })).toBe("a");
    expect(userAssertionOf({ headers: {} })).toBeUndefined();
    expect(userAssertionOf({ headers: { [USER_ASSERTION_HEADER]: "" } })).toBeUndefined();
  });

  it("moves the assertion out of the body and into a header", () => {
    const relay = approverForBroker({ id: "alice", email: "alice@example.com", assertion: "tok" });
    expect(JSON.parse(relay.body)).toEqual({ approver: { id: "alice", email: "alice@example.com" } });
    expect(relay.headers).toEqual({ [USER_ASSERTION_HEADER]: "tok" });
  });

  it("sends no header without an assertion", () => {
    expect(approverForBroker({ id: "alice" }).headers).toEqual({});
  });
});
