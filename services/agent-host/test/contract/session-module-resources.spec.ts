/**
 * Tier 1 contract — module registry stage 2: the session manager composes a
 * conversation's EFFECTIVE resources as
 *   explicit override  ->  wins outright
 *   else               ->  deployment/platform baseline + Σ enabled modules
 * and revive() carries that total onto the resumed pod. See todo/MODULE_REGISTRY.md.
 */

import { describe, it, expect, vi } from "vitest";

import {
  createSessionManager,
  type SandboxProvisioner,
  type ConversationStore,
} from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";
import type { SandboxRef, SessionId } from "../../src/types.js";
import type { SandboxResources } from "../../src/session/resources.js";

/** A provisioner whose resume() records the resources it was handed. */
function recordingProvisioner() {
  const resumeResources: Array<SandboxResources | undefined> = [];
  const provisioner: SandboxProvisioner = {
    create: vi.fn(async (id) => ({ name: `conv-${id}`, namespace: "ns" }) as SandboxRef),
    suspend: vi.fn(async () => {}),
    resume: vi.fn(async (ref: SandboxRef, resources?: SandboxResources) => {
      resumeResources.push(resources);
      return ref;
    }),
    destroy: vi.fn(async () => {}),
  };
  return { provisioner, resumeResources };
}

const inMemoryStore = (): ConversationStore => {
  const logs = new Map<SessionId, AguiEvent[]>();
  return {
    appendEvent: async (id, e) => {
      (logs.get(id) ?? logs.set(id, []).get(id)!).push(e);
    },
    async *readEvents(id) {
      yield* logs.get(id) ?? [];
    },
    gooseStatePath: (id) => `/state/${id}/goose`,
  };
};

const DEPLOY_DEFAULT: SandboxResources = { requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "4Gi" } };

let threadSeq = 0;
async function newConv(sessions: ReturnType<typeof createSessionManager>): Promise<SessionId> {
  const conv = await sessions.start(`thread-${threadSeq++}`);
  return conv.id;
}

describe("effectiveResources composition", () => {
  it("returns just the deployment default when no override and no modules", async () => {
    const { provisioner } = recordingProvisioner();
    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      deploymentDefaultResources: DEPLOY_DEFAULT,
    });
    const id = await newConv(sessions);
    expect(await sessions.effectiveResources(id)).toEqual(DEPLOY_DEFAULT);
  });

  it("ADDS enabled modules onto the baseline (cpu/mem additive, gpu max)", async () => {
    const { provisioner } = recordingProvisioner();
    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      deploymentDefaultResources: DEPLOY_DEFAULT,
      enabledModuleResources: async () => [
        { requests: { cpu: "1", memory: "1Gi" }, limits: { gpu: 1 } },
      ],
    });
    const id = await newConv(sessions);
    const eff = await sessions.effectiveResources(id);
    expect(eff.requests?.cpu).toBe("1500m"); // 500m + 1
    expect(eff.requests?.memory).toBe("2Gi"); // 1Gi + 1Gi
    expect(eff.limits?.gpu).toBe(1);
  });

  it("an EXPLICIT override WINS — a module never grows it", async () => {
    const { provisioner } = recordingProvisioner();
    const override: SandboxResources = { requests: { cpu: "8", memory: "16Gi" } };
    const sessions = createSessionManager({
      provisioner,
      store: inMemoryStore(),
      deploymentDefaultResources: DEPLOY_DEFAULT,
      enabledModuleResources: async () => [{ requests: { cpu: "4", memory: "4Gi" } }],
      isSwitching: () => false,
    });
    const id = await newConv(sessions);
    await sessions.setResourcesNow(id, override); // sets the explicit override
    // Even with a resource-declaring module enabled, the override stands unchanged.
    expect(await sessions.effectiveResources(id)).toEqual(override);
  });
});
