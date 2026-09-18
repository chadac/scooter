/**
 * Does a declared workload fit the sandbox it's about to run in?
 *
 * A web service declares what it needs (webServices.<name>.resources in the
 * sandbox-os config). That number is ADVISORY — it never sizes the pod and never
 * blocks a start. Its only job is to turn the worst failure mode in this system,
 * "my notebook died and I don't know why", into "marimo wants 8Gi, this sandbox is
 * 4Gi". An OOM kill leaves no message in the service's own logs, so without this
 * comparison the gap is close to undiagnosable from inside the pod.
 *
 * Compared against the sandbox's LIMITS, not its requests: limits are the hard cap
 * the kernel enforces, so that's what a workload actually gets killed against.
 *
 * Every function here is total — an unparseable or absent quantity yields "can't
 * judge" (no shortfall) rather than a guess, because a false "won't fit" warning
 * trains the reader to ignore a true one.
 */

import type { SandboxResources } from "./resources.js";

/** What a workload says it needs. Every dimension optional — an omitted one means
 *  "no opinion", which is different from zero. */
export interface ResourceNeed {
  cpu?: string;
  memory?: string;
  gpu?: number;
}

/** Binary (Ki/Mi/…) and decimal (K/M/…) multipliers, per the k8s quantity format. */
const MEMORY_UNITS: Record<string, number> = {
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
  K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
};

/** A k8s cpu quantity → millicores. "2" → 2000, "500m" → 500. undefined if unparseable. */
export function cpuToMillicores(q: string | undefined): number | undefined {
  if (typeof q !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)(m?)$/.exec(q.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2] === "m" ? n : n * 1000;
}

/** A k8s memory quantity → bytes. "1Gi" → 1073741824, "512Mi", "2G", bare "1024". */
export function memoryToBytes(q: string | undefined): number | undefined {
  if (typeof q !== "string") return undefined;
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|Pi|Ei|K|M|G|T|P|E)?$/.exec(q.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return m[2] ? n * MEMORY_UNITS[m[2]] : n;
}

/** One dimension where the workload wants more than the sandbox has. */
export interface Shortfall {
  dimension: "cpu" | "memory" | "gpu";
  /** The declared requirement, as written. */
  need: string;
  /** What the sandbox actually caps at, as written. */
  have: string;
}

/**
 * The dimensions where `need` exceeds the sandbox's limits. Empty = fits, or we
 * couldn't tell. A dimension the sandbox doesn't cap is unbounded, so it never
 * produces a shortfall.
 */
export function shortfalls(need: ResourceNeed, have: SandboxResources | undefined): Shortfall[] {
  const limits = have?.limits;
  if (!limits) return [];
  const out: Shortfall[] = [];

  const needCpu = cpuToMillicores(need.cpu);
  const haveCpu = cpuToMillicores(limits.cpu);
  if (needCpu !== undefined && haveCpu !== undefined && needCpu > haveCpu) {
    out.push({ dimension: "cpu", need: need.cpu!, have: limits.cpu! });
  }

  const needMem = memoryToBytes(need.memory);
  const haveMem = memoryToBytes(limits.memory);
  if (needMem !== undefined && haveMem !== undefined && needMem > haveMem) {
    out.push({ dimension: "memory", need: need.memory!, have: limits.memory! });
  }

  // An absent gpu limit means zero GPUs, not "unbounded" — a sandbox without the
  // extended resource cannot run a GPU workload at all, so any positive need is a
  // shortfall. This is the one dimension where absence is a hard no.
  if (typeof need.gpu === "number" && need.gpu > 0) {
    const haveGpu = limits.gpu ?? 0;
    if (need.gpu > haveGpu) {
      out.push({ dimension: "gpu", need: `${need.gpu}`, have: `${haveGpu}` });
    }
  }

  return out;
}

/** Human one-liner for a set of shortfalls, or undefined when it fits. The same
 *  sentence is shown to the agent and in the UI, so they never disagree. */
/** The same gap in a few words, for the Sandbox tab's service card — ~120px wide at
 *  the panel's size, where fitAdvice()'s full sentence would wrap to nine lines. The
 *  card pairs this with fitAdvice() as its tooltip, so the terse form never has to
 *  carry the whole explanation. */
export function fitSummary(need: ResourceNeed, have: SandboxResources | undefined): string | undefined {
  const gaps = shortfalls(need, have);
  if (gaps.length === 0) return undefined;
  return `Needs ${gaps.map((g) => (g.dimension === "gpu" ? `${g.need} GPU` : `${g.need} ${g.dimension}`)).join(" + ")}`;
}

export function fitAdvice(
  serviceName: string,
  need: ResourceNeed,
  have: SandboxResources | undefined,
): string | undefined {
  const gaps = shortfalls(need, have);
  if (gaps.length === 0) return undefined;
  const parts = gaps.map((g) =>
    g.dimension === "gpu"
      ? `${g.need} GPU (this sandbox has ${g.have})`
      : `${g.need} ${g.dimension} (this sandbox caps at ${g.have})`,
  );
  return (
    `${serviceName} declares it needs ${parts.join(" and ")}. ` +
    `It will still start, but may be throttled or OOM-killed — consider a larger sandbox size.`
  );
}
