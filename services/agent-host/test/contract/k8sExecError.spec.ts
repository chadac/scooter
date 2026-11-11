/** A rejected k8s exec becomes an Error whose message carries the Status, never `[object Object]`. */

import { describe, it, expect } from "vitest";

import { K8sExecError, openExecWithRetry, toExecError } from "../../src/exec/k8sExec.js";

/** How client-node rejects a refused ws upgrade. */
const refused = (code: number) => ({ error: new Error(`Unexpected server response: ${code}`) });

describe("toExecError", () => {
  it("serializes a bare k8s Status", () => {
    const e = toExecError({
      kind: "Status",
      status: "Failure",
      reason: "NotFound",
      message: 'pods "conv-abc" not found',
      code: 404,
    });
    expect(e).toBeInstanceOf(K8sExecError);
    expect(e.message).toBe('k8s exec failed: NotFound: pods "conv-abc" not found (code 404)');
    expect(e.status?.code).toBe(404);
    expect(String(e)).not.toContain("[object Object]");
  });

  it("reads the Status out of an ApiException body, JSON or parsed", () => {
    const body = { kind: "Status", status: "Failure", reason: "Forbidden", message: "nope", code: 403 };
    expect(toExecError({ body: JSON.stringify(body) }).message).toContain("Forbidden: nope (code 403)");
    expect(toExecError(Object.assign(new Error("HTTP 403"), { body })).message).toContain("Forbidden: nope");
  });

  it("unwraps a ws ErrorEvent and keeps the close frame", () => {
    const e = toExecError({ error: new Error("socket hang up") }, { code: 1006, reason: "" });
    expect(e.message).toBe("k8s exec failed: socket hang up (ws close 1006)");
  });

  it("never prints [object Object] for an opaque value", () => {
    expect(toExecError({ weird: { nested: 1 } }).message).toBe('k8s exec failed: {"weird":{"nested":1}}');
    expect(toExecError({}).message).toBe("k8s exec failed: no error detail");
  });

  it("exposes a refused upgrade's HTTP status", () => {
    expect(toExecError(refused(404)).httpStatus).toBe(404);
    expect(toExecError({ error: new Error("socket hang up") }).httpStatus).toBeUndefined();
  });
});

describe("openExecWithRetry", () => {
  const noSleep = async () => {};

  it("retries a 5xx upgrade until it opens", async () => {
    let calls = 0;
    const ws = await openExecWithRetry(async () => {
      if (++calls < 3) throw refused(500);
      return "ws";
    }, noSleep);
    expect(ws).toBe("ws");
    expect(calls).toBe(3);
  });

  it("gives up on a 5xx after three attempts", async () => {
    let calls = 0;
    const p = openExecWithRetry(async () => {
      calls++;
      throw refused(500);
    }, noSleep);
    await expect(p).rejects.toMatchObject({ httpStatus: 500 });
    expect(calls).toBe(3);
  });

  it("does not retry a 404, the pod is gone", async () => {
    let calls = 0;
    const p = openExecWithRetry(async () => {
      calls++;
      throw refused(404);
    }, noSleep);
    await expect(p).rejects.toMatchObject({ httpStatus: 404 });
    expect(calls).toBe(1);
  });
});
