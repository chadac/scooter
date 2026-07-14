/**
 * suggestedTotal — sum a conversation's ENABLED modules' resource asks on top of a
 * baseline, per todo/MODULE_REGISTRY.md: cpu ADDITIVE, memory ADDITIVE, gpu = MAX.
 *
 * A module raising the total means the sandbox needs a bigger pod; the result feeds
 * the resource resolve chain (the "restart to apply new limits" path from the
 * restart-resources feature). A module with NO `resources` contributes nothing
 * (software without a size bump — legit, not an error).
 *
 * Pure + unit-testable; the quantity math lives in session/resources.ts.
 */

import {
  cpuToMillis,
  millisToCpu,
  memToBytes,
  bytesToMem,
  type SandboxResources,
} from "../session/resources.js";

/** One side (requests | limits) folded across baseline + modules: cpu/mem summed,
 *  gpu maxed. Undefined dimensions contribute 0 (and stay absent if the total is 0). */
function foldSide(
  sides: Array<{ cpu?: string; memory?: string; gpu?: number } | undefined>,
): { cpu?: string; memory?: string; gpu?: number } | undefined {
  let cpuM = 0;
  let memB = 0;
  let gpu = 0;
  let sawCpu = false;
  let sawMem = false;
  let sawGpu = false;
  for (const s of sides) {
    if (!s) continue;
    if (s.cpu !== undefined) { cpuM += cpuToMillis(s.cpu); sawCpu = true; }
    if (s.memory !== undefined) { memB += memToBytes(s.memory); sawMem = true; }
    if (s.gpu !== undefined) { gpu = Math.max(gpu, s.gpu); sawGpu = true; }
  }
  const out: { cpu?: string; memory?: string; gpu?: number } = {};
  if (sawCpu) out.cpu = millisToCpu(cpuM);
  if (sawMem) out.memory = bytesToMem(memB);
  if (sawGpu) out.gpu = gpu;
  return Object.keys(out).length ? out : undefined;
}

/**
 * The suggested total resources = baseline + Σ(enabled module resources), with cpu
 * and memory additive and gpu taken as the max. `baseline` is the conversation's
 * effective base (deployment/platform default); `moduleResources` is the enabled
 * modules' declared asks (skip disabled ones before calling).
 */
export function suggestedTotal(
  baseline: SandboxResources,
  moduleResources: Array<SandboxResources | undefined>,
): SandboxResources {
  const all = [baseline, ...moduleResources];
  const total: SandboxResources = {};
  const requests = foldSide(all.map((r) => r?.requests));
  const limits = foldSide(all.map((r) => r?.limits));
  if (requests) total.requests = requests;
  if (limits) total.limits = limits;
  return total;
}
