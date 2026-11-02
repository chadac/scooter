import { describe, expect, it } from "vitest";
import { rootSandboxName, shortId } from "../../src/session/manager.js";
import type { ThreadId } from "../../src/types.js";

const ID = "5a515e73-860b-49ba-bc3f-6ff8d5fda5ff" as ThreadId;
const legacy = `conv-${shortId(ID)}`;
const onCluster = (...names: string[]) => (n: string) => names.includes(n);

describe("rootSandboxName", () => {
  it("prefers the recorded Sandbox", () => {
    expect(rootSandboxName({ threadId: ID, sandboxRef: "conv-x" }, onCluster(`conv-${ID}`))).toBe("conv-x");
  });

  it("keeps the legacy name for an unrecorded conversation whose Sandbox is gone @proves", () => {
    // Its workspace PVC is still named after the legacy Sandbox.
    expect(rootSandboxName({ threadId: ID }, onCluster())).toBe(legacy);
    expect(rootSandboxName({ threadId: ID })).toBe(legacy);
  });

  it("uses the full-id Sandbox when that one exists", () => {
    expect(rootSandboxName({ threadId: ID }, onCluster(`conv-${ID}`))).toBe(`conv-${ID}`);
  });

  it("uses the legacy Sandbox when it exists", () => {
    expect(rootSandboxName({ threadId: ID }, onCluster(legacy))).toBe(legacy);
  });
});
