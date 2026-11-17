/**
 * Sandbox resources: the friendly cpu/memory/gpu shape the agent and user speak, and the
 * validator that guards the tool/API boundary. The agent-host validates tool input,
 * renders the friendly shape into a k8s `resources` block, and un-renders what it reads
 * back off the Sandbox CR, which is the source of truth for a conversation's size.
 * Render and un-render must round-trip, because the UI derives the selected preset by
 * comparing cpu/memory/gpu against the catalog.
 */

/** The friendly resource shape: cpu and memory are k8s quantity strings, gpu is a whole-device
 *  count, and an omitted dimension is simply not set. */
export interface SandboxResources {
  requests?: { cpu?: string; memory?: string; gpu?: number };
  limits?: { cpu?: string; memory?: string; gpu?: number };
}

/** Thrown by validateResources on a malformed quantity/count, carrying which field failed. */
export class InvalidResourceError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    message: string,
  ) {
    super(message);
    this.name = "InvalidResourceError";
  }
}

const CPU_RE = /^\d+m?$/; // "500m", "2" — integer millicpu or whole cores
const MEMORY_RE = /^\d+(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/; // "1Gi", "512Mi", "2G", "1024"

/** Validate a friendly resources value at the tool/API boundary (cpu `^\d+m?$`, memory
 *  `^\d+(Ki|Mi|Gi|Ti|K|M|G|T)?$`, gpu a non-negative integer), returning it unchanged or throwing
 *  InvalidResourceError. */
export function validateResources(r: SandboxResources): SandboxResources {
  for (const side of ["requests", "limits"] as const) {
    const q = r[side];
    if (!q) continue;
    if (q.cpu !== undefined && !CPU_RE.test(q.cpu)) {
      throw new InvalidResourceError(`${side}.cpu`, q.cpu, `invalid cpu quantity "${q.cpu}" (e.g. "500m" or "2")`);
    }
    if (q.memory !== undefined && !MEMORY_RE.test(q.memory)) {
      throw new InvalidResourceError(`${side}.memory`, q.memory, `invalid memory quantity "${q.memory}" (e.g. "1Gi" or "512Mi")`);
    }
    if (q.gpu !== undefined && (!Number.isInteger(q.gpu) || q.gpu < 0)) {
      throw new InvalidResourceError(`${side}.gpu`, q.gpu, `invalid gpu count ${q.gpu} (a non-negative whole number)`);
    }
  }
  return r;
}

/** k8s extended-resource name for a whole GPU (scooter.sandboxGpuResource); a GPU request must
 *  equal its limit, so one friendly `gpu` count renders on both sides. */
export const GPU_RESOURCE = process.env.SANDBOX_GPU_RESOURCE || "nvidia.com/gpu";

/** A k8s container `resources` block: arbitrary quantity strings per side, including extended
 *  resources like nvidia.com/gpu. */
export interface RenderedResources {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

/**
 * Platform fallback when a conversation has no size and the deployment configures no
 * presets; requests == limits gives Guaranteed QoS, so one runaway sandbox cannot starve
 * its neighbours.
 */
export const PLATFORM_DEFAULT: SandboxResources = {
  requests: { cpu: "2", memory: "4Gi" },
  limits: { cpu: "2", memory: "4Gi" },
};

/** Friendly -> the k8s container `resources` block: cpu/memory pass through, gpu renders as
 *  nvidia.com/gpu on both sides, and empty sides are omitted. */
export function renderResources(r: SandboxResources): RenderedResources {
  const gpu = r.requests?.gpu ?? r.limits?.gpu;
  const side = (q: SandboxResources["requests"]): Record<string, string> => {
    const out: Record<string, string> = {};
    if (q?.cpu !== undefined) out.cpu = q.cpu;
    if (q?.memory !== undefined) out.memory = q.memory;
    if (gpu !== undefined) out[GPU_RESOURCE] = String(gpu);
    return out;
  };
  const block: RenderedResources = {};
  const requests = side(r.requests);
  const limits = side(r.limits);
  if (Object.keys(requests).length) block.requests = requests;
  if (Object.keys(limits).length) block.limits = limits;
  return block;
}

/** The inverse of renderResources, turning nvidia.com/gpu back into a number; an unparseable gpu
 *  count is dropped rather than surfaced as NaN. */
export function unrenderResources(block: RenderedResources | undefined): SandboxResources {
  const side = (q: Record<string, string> | undefined): SandboxResources["requests"] | undefined => {
    if (!q) return undefined;
    const out: NonNullable<SandboxResources["requests"]> = {};
    if (q.cpu !== undefined) out.cpu = q.cpu;
    if (q.memory !== undefined) out.memory = q.memory;
    const gpu = q[GPU_RESOURCE];
    if (gpu !== undefined) {
      const n = Number(gpu);
      if (Number.isInteger(n) && n >= 0) out.gpu = n;
    }
    return Object.keys(out).length ? out : undefined;
  };
  const out: SandboxResources = {};
  const requests = side(block?.requests);
  const limits = side(block?.limits);
  if (requests) out.requests = requests;
  if (limits) out.limits = limits;
  return out;
}

/** A named size preset from the deployment's catalog (SANDBOX_SIZES_JSON). */
export interface SandboxSizePreset {
  cpu: string;
  memory: string;
  gpu?: number;
  /** Deployment guidance for when to pick this size, shown to the agent and under the UI dropdown. */
  hint?: string;
}

/** Parse the deployment's preset catalog; empty or malformed yields {} so a bad catalog cannot stop
 *  a conversation from starting. */
export function parsePresets(raw: string | undefined): Record<string, SandboxSizePreset> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, SandboxSizePreset>)
      : {};
  } catch {
    return {};
  }
}

/** A preset -> the friendly shape with requests == limits, validated so a malformed preset fails
 *  where it can be reported. */
export function presetToResources(p: SandboxSizePreset): SandboxResources {
  const side = { cpu: p.cpu, memory: p.memory, ...(p.gpu !== undefined && p.gpu !== null ? { gpu: p.gpu } : {}) };
  return validateResources({ requests: { ...side }, limits: { ...side } });
}
