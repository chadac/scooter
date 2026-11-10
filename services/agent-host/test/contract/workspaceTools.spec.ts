/** expand_workspace and the show_sandbox_resources workspace line. */

import { describe, it, expect, vi } from "vitest";

import { handleExpandWorkspace, type WorkspaceToolsWiring } from "../../src/agent/workspaceTools.js";
import { handleShowSandboxResources } from "../../src/agent/resourceTools.js";
import type { WorkspaceVolume } from "../../src/session/workspaceVolume.js";

function wiring(vol: WorkspaceVolume | undefined, limits = { max: "200Gi", autoMax: "50Gi" }) {
  const grows: string[] = [];
  const deps: WorkspaceToolsWiring = {
    limits,
    volume: {
      getWorkspace: async () => (grows.length ? { requested: grows.at(-1)!, capacity: grows.at(-1)! } : vol),
      growWorkspace: async (_id, size) => void grows.push(size),
    },
    requestApproval: vi.fn(async () => {}),
    grow: { sleep: async () => {}, pollMs: 0 },
  };
  return { deps, grows };
}

describe("expand_workspace", () => {
  it("grows at once up to the soft limit", async () => {
    const { deps, grows } = wiring({ requested: "10Gi", capacity: "10Gi" });
    const res = await handleExpandWorkspace(deps, "c1", { size: "40Gi", reason: "big clone" });
    expect(res.isError).toBeFalsy();
    expect(grows).toEqual(["40Gi"]);
    expect(deps.requestApproval).not.toHaveBeenCalled();
    expect(res.content[0].text).toContain("now 40Gi");
  });

  it("raises a card above the soft limit instead of growing", async () => {
    const { deps, grows } = wiring({ requested: "10Gi", capacity: "10Gi" });
    const res = await handleExpandWorkspace(deps, "c1", { size: "100Gi", reason: "dataset" });
    expect(grows).toEqual([]);
    expect(deps.requestApproval).toHaveBeenCalledWith("c1", { from: "10Gi", size: "100Gi", reason: "dataset" });
    expect(res.content[0].text).toContain("asks the owner");
  });

  it("needs a reason", async () => {
    const { deps } = wiring({ requested: "10Gi" });
    expect((await handleExpandWorkspace(deps, "c1", { size: "20Gi" })).isError).toBe(true);
  });

  it("refuses a size past the max", async () => {
    const { deps } = wiring({ requested: "10Gi" });
    const res = await handleExpandWorkspace(deps, "c1", { size: "1Ti", reason: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("200Gi");
  });
});

describe("show_sandbox_resources workspace line", () => {
  const show = (ws: WorkspaceToolsWiring | undefined) =>
    handleShowSandboxResources({ currentResources: async () => ({}), setResources: async () => true, workspace: ws }, "c1");

  it("shows the size and both limits", async () => {
    const text = (await show(wiring({ requested: "10Gi", capacity: "10Gi" }).deps)).content[0].text;
    expect(text).toContain("workspace: 10Gi");
    expect(text).toContain("up to 50Gi on your own, up to 200Gi with the owner's approval");
  });

  it("shows a resize in flight", async () => {
    const text = (await show(wiring({ requested: "20Gi", capacity: "10Gi" }).deps)).content[0].text;
    expect(text).toContain("workspace: 10Gi (resizing to 20Gi)");
  });

  it("has one limit when there is no soft limit, and no line when growth is off", async () => {
    const one = (await show(wiring({ requested: "10Gi" }, { max: "200Gi", autoMax: "200Gi" }).deps)).content[0].text;
    expect(one).toContain("expand_workspace, up to 200Gi\n");
    expect((await show(undefined)).content[0].text).not.toContain("workspace");
  });
});
