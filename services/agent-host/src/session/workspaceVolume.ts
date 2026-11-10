/** Grows a conversation's /workspace PVC while its pod runs. */

import type { AguiEvent } from "../bridge.js";
import { memoryToBytes } from "./resourceFit.js";

/** A workspace claim's size as Kubernetes reports it. */
export interface WorkspaceVolume {
  /** spec.resources.requests.storage */
  requested: string;
  /** status.capacity.storage: what the mounted filesystem has now. */
  capacity?: string;
  /** Why a resize hasn't finished, e.g. "FileSystemResizePending". */
  pending?: string;
  /** The latest resize failure, when it is newer than any success. */
  failure?: string;
}

/** Reads and grows a workspace claim; the wiring picks the key. */
export interface WorkspaceVolumeClient {
  /** undefined when the conversation has no workspace claim yet. */
  getWorkspace(key: string): Promise<WorkspaceVolume | undefined>;
  /** Raise the claim's request; non-expandable classes are refused. */
  growWorkspace(key: string, size: string): Promise<void>;
}

/** Growth ceilings: autoMax without asking, max with approval. */
export interface WorkspaceLimits {
  max: string;
  autoMax: string;
}

/** Parses the limit env vars; no max disables growth. */
export function parseWorkspaceLimits(max: string | undefined, autoMax: string | undefined): WorkspaceLimits | undefined {
  if (!max?.trim()) return undefined;
  const m = max.trim();
  const a = autoMax?.trim() || m;
  for (const q of [m, a]) {
    if (memoryToBytes(q) === undefined) throw new Error(`workspace storage limit "${q}" is not a k8s quantity`);
  }
  if (bytes(a) > bytes(m)) throw new Error(`workspace auto-expand limit ${a} exceeds the max ${m}`);
  return { max: m, autoMax: a };
}

const bytes = (q: string): number => memoryToBytes(q) ?? NaN;

/** A growth request's fate: refused, automatic, or needs approval. */
export type GrowthCheck =
  | { kind: "refused"; reason: string }
  | { kind: "auto" | "approval"; from: string };

/** Classify a request to grow `vol` to `size` under `limits`. */
export function checkGrowth(limits: WorkspaceLimits, vol: WorkspaceVolume | undefined, size: string): GrowthCheck {
  const want = memoryToBytes(size);
  if (want === undefined) return { kind: "refused", reason: `"${size}" is not a size; use a k8s quantity like "50Gi".` };
  if (!vol) return { kind: "refused", reason: "This sandbox has no workspace volume to grow." };
  if (want <= bytes(vol.requested)) {
    return { kind: "refused", reason: `/workspace is already ${vol.requested}; volumes only grow, so ask for more than that.` };
  }
  if (want > bytes(limits.max)) return { kind: "refused", reason: `${size} is over this deployment's limit of ${limits.max}.` };
  return { kind: want > bytes(limits.autoMax) ? "approval" : "auto", from: vol.requested };
}

export interface GrowOptions {
  timeoutMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Grows, then waits for the filesystem; returns the agent's message. */
export async function growAndWait(
  client: WorkspaceVolumeClient,
  key: string,
  size: string,
  opts: GrowOptions = {},
): Promise<{ ok: boolean; text: string }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 2000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  try {
    await client.growWorkspace(key, size);
  } catch (e) {
    return { ok: false, text: `Kubernetes refused to grow /workspace to ${size}: ${errorText(e)}` };
  }
  let last: WorkspaceVolume | undefined;
  for (;;) {
    last = await client.getWorkspace(key).catch(() => last);
    if (last?.capacity && bytes(last.capacity) >= bytes(size)) {
      return { ok: true, text: `/workspace is now ${last.capacity}; no restart needed.` };
    }
    if (last?.failure) return { ok: false, text: `Growing /workspace to ${size} failed: ${last.failure}` };
    if (Date.now() >= deadline) break;
    await sleep(pollMs);
  }
  const why = last?.pending ? ` (${last.pending})` : "";
  return {
    ok: true,
    text: `Asked for ${size}; /workspace is still ${last?.capacity ?? "unknown"} and resizing${why}. Check show_sandbox_resources in a minute.`,
  };
}

/** Approval-card contrib name for growth above the soft limit. */
export const WORKSPACE_EXPAND_CONTRIB = "workspace-expand";

/** Card metadata, so the answer grows to exactly what the owner saw. */
export interface WorkspaceExpandRequest {
  from: string;
  size: string;
  reason: string;
}

/** The card's text: the growth asked for, and why. */
export function workspaceExpandMessage(req: WorkspaceExpandRequest, limits: WorkspaceLimits): string {
  return (
    `The agent asks to grow /workspace from ${req.from} to ${req.size}, above the ${limits.autoMax} ` +
    `it may use without asking. Volumes can't shrink, so the cost stays until the conversation is deleted.` +
    `\n\nThe agent's reason: ${req.reason}`
  );
}

/** The growth request card `id` raised, answered or not. */
export function workspaceExpandRequestOf(events: AguiEvent[], id: string): WorkspaceExpandRequest | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "RUN_FINISHED" || e.outcome?.type !== "interrupt") continue;
    const raised = e.outcome.interrupts.find((x) => x.id === id);
    if (!raised) continue;
    const req = raised.metadata?.workspace as Partial<WorkspaceExpandRequest> | undefined;
    return typeof req?.size === "string" && typeof req.from === "string" && typeof req.reason === "string"
      ? { size: req.size, from: req.from, reason: req.reason }
      : undefined;
  }
  return undefined;
}

export interface WorkspaceExpandAnswerDeps {
  /** The root conversation's owner, if known. */
  owner(conversationId: string): Promise<string | undefined>;
  events(conversationId: string): Promise<AguiEvent[]>;
  limits: WorkspaceLimits;
  volume: WorkspaceVolumeClient;
  /** Tell the agent the outcome. */
  tell(conversationId: string, text: string): void;
  grow?: GrowOptions;
}

/** Applies the owner's answer to a growth card, then tells the agent. */
export async function answerWorkspaceExpand(
  deps: WorkspaceExpandAnswerDeps,
  conversationId: string,
  requestId: string,
  optionId: string,
  approver: { id: string },
): Promise<void> {
  const owner = await deps.owner(conversationId);
  if (!owner || approver.id !== owner) throw new Error("only the conversation's owner can approve growing its workspace");
  const req = workspaceExpandRequestOf(await deps.events(conversationId), requestId);
  if (!req) throw new Error(`workspace request ${requestId} is not in the conversation's log`);
  if (optionId !== "approve") {
    deps.tell(conversationId, `The owner declined growing /workspace to ${req.size}. Free space instead, and don't ask again unless they say to.`);
    return;
  }

  // Re-checked: volume or limits may have changed since asking.
  const check = checkGrowth(deps.limits, await deps.volume.getWorkspace(conversationId), req.size);
  if (check.kind === "refused") {
    deps.tell(conversationId, `The owner approved growing /workspace to ${req.size}, but it wasn't applied: ${check.reason}`);
    return;
  }
  const out = await growAndWait(deps.volume, conversationId, req.size, deps.grow);
  deps.tell(conversationId, `The owner approved growing /workspace to ${req.size}. ${out.text}`);
}

function errorText(e: unknown): string {
  const body = (e as { body?: unknown })?.body;
  if (typeof body === "string" && body) {
    try {
      const msg = (JSON.parse(body) as { message?: unknown }).message;
      if (typeof msg === "string") return msg;
    } catch {
      return body;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
