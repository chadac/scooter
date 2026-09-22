/**
 * Sandbox resources — the friendly cpu/memory/gpu shape the agent + user speak,
 * and the validator that guards the tool/API boundary.
 *
 * The agent-host owns sizing end to end: it validates tool input, renders the friendly
 * shape into a k8s `resources` block, and un-renders what it reads back off the Sandbox
 * CR — which is the SOURCE OF TRUTH for a conversation's size (there is no size table).
 *
 * Render and un-render MUST round-trip. The UI derives the selected preset by comparing
 * cpu/memory/gpu against the catalog, so a `gpu` that comes back as the rendered
 * `nvidia.com/gpu: "1"` instead of `gpu: 1` matches no preset and the picker silently
 * shows "Custom" for a size that is in fact a preset.
 */

/** The friendly, user/agent-facing resource shape. cpu + memory are k8s quantity
 *  strings ("500m", "2", "1Gi"); gpu is a whole-device count. All optional — an
 *  omitted dimension is simply not set (keeps the current/default for it). */
export interface SandboxResources {
  requests?: { cpu?: string; memory?: string; gpu?: number };
  limits?: { cpu?: string; memory?: string; gpu?: number };
}

/** Thrown by validateResources on a malformed quantity/count. Carries which
 *  field failed so the tool/API can tell the agent exactly what to fix. */
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

/**
 * Validate a friendly resources value at the tool/API boundary — a bad quantity
 * must NEVER reach the broker/CR (fail-safe: reject, don't silently drop to default).
 *   cpu:    ^\d+m?$                     ("500m", "2")
 *   memory: ^\d+(Ki|Mi|Gi|Ti|K|M|G|T)?$ ("1Gi", "512Mi", "2G")
 *   gpu:    non-negative integer
 * Returns the (unchanged) value on success; throws InvalidResourceError otherwise.
 */
const CPU_RE = /^\d+m?$/; // "500m", "2" — integer millicpu or whole cores
const MEMORY_RE = /^\d+(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/; // "1Gi", "512Mi", "2G", "1024"

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

/** k8s extended-resource name for a whole GPU. A GPU request MUST equal its limit, so
 *  one friendly `gpu` count renders on BOTH sides. */
export const GPU_RESOURCE = "nvidia.com/gpu";

/** A k8s container `resources` block: arbitrary quantity strings per side (cpu, memory,
 *  and extended resources like nvidia.com/gpu). */
export interface RenderedResources {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

/**
 * Platform fallback when a conversation has no size and the deployment configures no
 * presets. Requests == limits (cpu AND memory) => Guaranteed QoS: the scheduler reserves
 * the full amount per pod and the pod is HARD-capped there, so one runaway sandbox can't
 * burst into its neighbours and starve them.
 */
export const PLATFORM_DEFAULT: SandboxResources = {
  requests: { cpu: "2", memory: "4Gi" },
  limits: { cpu: "2", memory: "4Gi" },
};

/** Friendly -> the k8s container `resources` block. cpu/memory pass through; gpu
 *  renders as nvidia.com/gpu on BOTH sides (set on either side sets both). Empty sides
 *  are omitted, so a partial size never reserves nothing/everything by accident. */
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

/** The inverse of renderResources: the k8s block read back off the Sandbox CR -> the
 *  friendly shape. nvidia.com/gpu becomes a NUMBER again (see the module header: the
 *  UI's preset matching compares on it). An unparseable gpu count is dropped rather
 *  than surfaced as NaN. */
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
  /** Deployment guidance for when to pick this size, shown to the agent and under the
   *  UI dropdown. Absent when the deployment set none. */
  hint?: string;
}

/** Parse the deployment's preset catalog. Empty/malformed -> {} (no presets: the agent
 *  and UI fall back to setting raw resources), because a bad catalog must not stop a
 *  conversation from starting. */
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

/** A preset -> the friendly shape, requests == limits (Guaranteed QoS). Validates, so a
 *  malformed preset fails where it can be reported rather than at the CR. */
export function presetToResources(p: SandboxSizePreset): SandboxResources {
  const side = { cpu: p.cpu, memory: p.memory, ...(p.gpu !== undefined && p.gpu !== null ? { gpu: p.gpu } : {}) };
  return validateResources({ requests: { ...side }, limits: { ...side } });
}
