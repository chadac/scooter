/**
 * Sandbox resources — the friendly cpu/memory/gpu shape the agent + user speak,
 * and the validator that guards the tool/API boundary.
 *
 * The agent-host only VALIDATES tool input and carries the friendly type; it does
 * NOT render/resolve/quantity-math or hold a platform default. Sizing is owned by
 * the BROKER now (see services/broker/broker/sandbox/resources.py — render/resolve
 * + the platform default live there); the agent-host just writes/reads the broker's
 * size spec via GET/PUT /sandbox/{conv}/size.
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
