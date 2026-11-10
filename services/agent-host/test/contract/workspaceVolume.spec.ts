/** Growth limits, waiting on the filesystem, and owner approval. */

import { describe, it, expect } from "vitest";

import type { AguiEvent } from "../../src/bridge.js";
import {
  answerWorkspaceExpand,
  checkGrowth,
  growAndWait,
  parseWorkspaceLimits,
  WORKSPACE_EXPAND_CONTRIB,
  type WorkspaceExpandAnswerDeps,
  type WorkspaceVolume,
  type WorkspaceVolumeClient,
} from "../../src/session/workspaceVolume.js";

const limits = { max: "200Gi", autoMax: "50Gi" };
const noSleep = { sleep: async () => {}, pollMs: 0 };

/** A claim that reaches its request after `polls` reads, or fails with `failure`. */
function fakeVolume(start: WorkspaceVolume, opts: { polls?: number; failure?: string; refuse?: string } = {}) {
  let vol = { ...start };
  let reads = 0;
  const grows: string[] = [];
  const client: WorkspaceVolumeClient = {
    getWorkspace: async () => {
      reads++;
      if (grows.length && opts.failure) return { ...vol, failure: opts.failure };
      if (grows.length && reads > (opts.polls ?? 0)) vol = { requested: vol.requested, capacity: vol.requested };
      return { ...vol };
    },
    growWorkspace: async (_key, size) => {
      if (opts.refuse) throw Object.assign(new Error("HTTP 422"), { body: JSON.stringify({ message: opts.refuse }) });
      grows.push(size);
      reads = 0;
      vol = { requested: size, capacity: vol.capacity, pending: "Resizing" };
    },
  };
  return { client, grows };
}

describe("parseWorkspaceLimits", () => {
  it("is off without a max, and defaults the soft limit to the max", () => {
    expect(parseWorkspaceLimits(undefined, "50Gi")).toBeUndefined();
    expect(parseWorkspaceLimits("200Gi", undefined)).toEqual({ max: "200Gi", autoMax: "200Gi" });
  });

  it("refuses a malformed quantity or a soft limit above the max", () => {
    expect(() => parseWorkspaceLimits("lots", undefined)).toThrow(/not a k8s quantity/);
    expect(() => parseWorkspaceLimits("50Gi", "1Ti")).toThrow(/exceeds the max/);
  });
});

describe("checkGrowth", () => {
  const vol = { requested: "10Gi", capacity: "10Gi" };

  it("grows alone up to the soft limit and asks above it", () => {
    expect(checkGrowth(limits, vol, "50Gi")).toEqual({ kind: "auto", from: "10Gi" });
    expect(checkGrowth(limits, vol, "51Gi")).toEqual({ kind: "approval", from: "10Gi" });
  });

  it("refuses shrinking, the same size, past the max, and a bad quantity", () => {
    for (const size of ["5Gi", "10Gi", "201Gi", "big"]) expect(checkGrowth(limits, vol, size).kind).toBe("refused");
  });

  it("compares across units", () => {
    expect(checkGrowth(limits, vol, "10240Mi").kind).toBe("refused");
    expect(checkGrowth(limits, vol, "10241Mi").kind).toBe("auto");
  });

  it("refuses when there is no claim", () => {
    expect(checkGrowth(limits, undefined, "20Gi").kind).toBe("refused");
  });
});

describe("growAndWait", () => {
  it("patches, then reports the new capacity once the filesystem follows", async () => {
    const { client, grows } = fakeVolume({ requested: "10Gi", capacity: "10Gi" }, { polls: 2 });
    const out = await growAndWait(client, "k", "20Gi", noSleep);
    expect(grows).toEqual(["20Gi"]);
    expect(out).toEqual({ ok: true, text: expect.stringContaining("now 20Gi") });
  });

  it("passes a resize failure through", async () => {
    const { client } = fakeVolume({ requested: "10Gi", capacity: "10Gi" }, { failure: "VolumeModificationRateExceeded" });
    const out = await growAndWait(client, "k", "20Gi", noSleep);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("VolumeModificationRateExceeded");
  });

  it("passes the API server's refusal through", async () => {
    const { client } = fakeVolume({ requested: "10Gi" }, { refuse: "storageclass that provisions the pvc must support resize" });
    const out = await growAndWait(client, "k", "20Gi", noSleep);
    expect(out.ok).toBe(false);
    expect(out.text).toContain("must support resize");
  });

  it("says it is still resizing when the deadline passes", async () => {
    const { client } = fakeVolume({ requested: "10Gi", capacity: "10Gi" }, { polls: 1000 });
    const out = await growAndWait(client, "k", "20Gi", { ...noSleep, timeoutMs: 0 });
    expect(out.ok).toBe(true);
    expect(out.text).toMatch(/still 10Gi and resizing \(Resizing\)/);
  });
});

describe("answerWorkspaceExpand", () => {
  const card = (id: string, size: string): AguiEvent =>
    ({
      type: "RUN_FINISHED",
      outcome: {
        type: "interrupt",
        interrupts: [{ id, metadata: { contrib: WORKSPACE_EXPAND_CONTRIB, requestId: id, workspace: { from: "10Gi", size, reason: "dataset" } } }],
      },
    }) as unknown as AguiEvent;

  function deps(vol: WorkspaceVolumeClient, events: AguiEvent[] = [card("r1", "120Gi")]) {
    const told: string[] = [];
    const d: WorkspaceExpandAnswerDeps = {
      owner: async () => "alice",
      events: async () => events,
      limits,
      volume: vol,
      tell: (_id, t) => told.push(t),
      grow: noSleep,
    };
    return { d, told };
  }

  it("grows to the card's size when the owner approves", async () => {
    const { client, grows } = fakeVolume({ requested: "10Gi", capacity: "10Gi" });
    const { d, told } = deps(client);
    await answerWorkspaceExpand(d, "c1", "r1", "approve", { id: "alice" });
    expect(grows).toEqual(["120Gi"]);
    expect(told[0]).toMatch(/approved.*now 120Gi/);
  });

  it("tells the agent of a decline without growing", async () => {
    const { client, grows } = fakeVolume({ requested: "10Gi" });
    const { d, told } = deps(client);
    await answerWorkspaceExpand(d, "c1", "r1", "deny", { id: "alice" });
    expect(grows).toEqual([]);
    expect(told[0]).toContain("declined");
  });

  it("refuses anyone but the owner", async () => {
    const { client, grows } = fakeVolume({ requested: "10Gi" });
    await expect(answerWorkspaceExpand(deps(client).d, "c1", "r1", "approve", { id: "mallory" })).rejects.toThrow(/owner/);
    expect(grows).toEqual([]);
  });

  it("re-checks the size, so an approval past a lowered max isn't applied", async () => {
    const { client, grows } = fakeVolume({ requested: "10Gi" });
    const { d, told } = deps(client);
    await answerWorkspaceExpand({ ...d, limits: { max: "100Gi", autoMax: "50Gi" } }, "c1", "r1", "approve", { id: "alice" });
    expect(grows).toEqual([]);
    expect(told[0]).toContain("wasn't applied");
  });

  it("rejects an unknown request id", async () => {
    const { client } = fakeVolume({ requested: "10Gi" });
    await expect(answerWorkspaceExpand(deps(client).d, "c1", "nope", "approve", { id: "alice" })).rejects.toThrow(/not in the conversation/);
  });
});
