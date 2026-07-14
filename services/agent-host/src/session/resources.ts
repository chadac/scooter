/**
 * Sandbox resources — the friendly cpu/memory/gpu shape the agent + user speak,
 * the validator that guards the tool/API boundary, and the render step that maps
 * it to the k8s container `resources` block.
 *
 * WHY a render step: the provisioner spreads a k8s resources block VERBATIM into
 * the container (k8sProvisioner.ts sandboxManifest). GPU is not a bare `gpu`
 * field in k8s — it's `nvidia.com/gpu` under requests AND limits (k8s requires
 * request==limit for extended resources). So the friendly `{ gpu: 2 }` must be
 * rendered into `{ requests: { "nvidia.com/gpu": "2" }, limits: { "nvidia.com/gpu": "2" } }`.
 * cpu/memory pass through unchanged.
 *
 * Design (PoC stage 2): signatures + doc only. Bodies throw `unimplemented`.
 */

/** The friendly, user/agent-facing resource shape. cpu + memory are k8s quantity
 *  strings ("500m", "2", "1Gi"); gpu is a whole-device count. All optional — an
 *  omitted dimension is simply not set (keeps the current/default for it). */
export interface SandboxResources {
  requests?: { cpu?: string; memory?: string; gpu?: number };
  limits?: { cpu?: string; memory?: string; gpu?: number };
}

/** The k8s container `resources` block (what actually goes on the pod). gpu has
 *  become `nvidia.com/gpu` under both requests and limits. */
export interface K8sResourceBlock {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}

/** The k8s extended-resource key a whole-GPU request renders to. */
export const GPU_RESOURCE = "nvidia.com/gpu";

/** The platform fallback when no conversation override and no deployment default
 *  apply: spread sandboxes across nodes (requests) + OOM-protect the node (mem
 *  limit), no cpu limit (bursty nix builds use spare CPU), no gpu. */
export const PLATFORM_DEFAULT_RESOURCES: SandboxResources = {
  requests: { cpu: "500m", memory: "1Gi" },
  limits: { memory: "4Gi" },
};

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
 * must NEVER reach the CR (fail-safe: reject, don't silently drop to default).
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

/**
 * Render the friendly shape into the k8s container `resources` block: cpu/memory
 * pass through; gpu → `nvidia.com/gpu` string on BOTH requests and limits (k8s
 * demands request==limit for gpu — a `gpu` in either requests or limits sets both).
 * Empty/omitted dimensions are not emitted (so no `requests: {}` noise).
 */
export function renderResources(r: SandboxResources): K8sResourceBlock {
  // k8s requires request==limit for an extended resource (gpu), so a gpu on
  // EITHER side sets both. Prefer an explicit value; requests wins if both given.
  const gpu = r.requests?.gpu ?? r.limits?.gpu;

  const side = (q: { cpu?: string; memory?: string; gpu?: number } | undefined): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    if (q?.cpu !== undefined) out.cpu = q.cpu;
    if (q?.memory !== undefined) out.memory = q.memory;
    if (gpu !== undefined) out[GPU_RESOURCE] = String(gpu);
    return Object.keys(out).length ? out : undefined;
  };

  const block: K8sResourceBlock = {};
  const requests = side(r.requests);
  const limits = side(r.limits);
  if (requests) block.requests = requests;
  if (limits) block.limits = limits;
  return block;
}

/**
 * Resolve the effective resources for a conversation at (re)provision time, in
 * order: the conversation's own override → the deployment default → the platform
 * default. Returns the FRIENDLY shape (caller renders it). Never returns
 * undefined — always lands on PLATFORM_DEFAULT_RESOURCES at worst.
 */
export function resolveResources(
  conversation: SandboxResources | undefined,
  deploymentDefault: SandboxResources | undefined,
): SandboxResources {
  return conversation ?? deploymentDefault ?? PLATFORM_DEFAULT_RESOURCES;
}
