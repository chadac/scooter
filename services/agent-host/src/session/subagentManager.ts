/** The SubagentManager implementation: spawn/list/check/cancel/send/monitor/search over injectable sessions and store. */

import { randomUUID } from "node:crypto";

import type { SessionId } from "../types.js";
import type { AguiEvent } from "../bridge.js";
import { SubagentLimitError, type SubagentManager, type SubagentStatus } from "../agent/subagentTools.js";
import { foldTurnsWithTools } from "../agent/subagentTranscript.js";
import { PRIORITY_INTERRUPT } from "../bridge.js";
import type { SubagentCreator } from "./routerSubagents.js";
import type { SpawnChildArgs } from "./manager.js";
import type { ConversationKind } from "./visibility.js";

/** The minimal child conversation shape the manager reasons about, a subset of SessionManager's
 *  Conversation. */
export interface SubagentConversation {
  id: string;
  title?: string;
  parentId?: string;
  kind?: ConversationKind;
  status?: string;
  bridge?: {
    queueState(): { running: boolean; queued?: number };
    cancel(): void;
  };
}

/** The bits of SessionManager the subagent manager drives (narrowed for testing). */
export interface SubagentSessions {
  get(id: SessionId): SubagentConversation | undefined;
  list(): SubagentConversation[];
  spawnChild(parentId: SessionId, childThreadId: string, args: SpawnChildArgs): Promise<{ id: string; title?: string }>;
  prompt(id: SessionId, text: string, model?: string, priority?: number, interrupt?: unknown, images?: unknown, files?: unknown, source?: string): Promise<void>;
}

/** The bits of the ConversationStore the manager reads (narrowed for testing). */
export interface SubagentStore {
  readEvents(id: SessionId): AsyncIterable<AguiEvent>;
  readEventsTail?(id: SessionId, runs: number): Promise<AguiEvent[]>;
}

/** A subagent's status as its parent sees it: ended, running (its bridge has a live run), or idle. */
export function subagentStatusOf(c: SubagentConversation): SubagentStatus["status"] {
  if (c.status === "ended") return "ended";
  return c.bridge?.queueState().running ? "running" : "idle";
}

/** Counts toward the caps: a live child with a turn running, queued, or about to start. */
export function subagentIsBusy(c: SubagentConversation): boolean {
  if (c.parentId === undefined || c.status !== "running") return false;
  if (!c.bridge) return true; // spawnChild has not wired its bridge yet
  const q = c.bridge.queueState();
  return q.running || (q.queued ?? 0) > 0;
}

async function collect(it: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  try {
    for await (const e of it) out.push(e);
  } catch {
    /* a read failure yields what we have */
  }
  return out;
}

/** Bounds on spawning, so delegation cannot fork-bomb a host. */
export interface SubagentLimits {
  /** Subagent nesting allowed: 1 means a subagent cannot spawn. */
  maxDepth: number;
  /** Running children one conversation may have at once. */
  maxRunningPerParent: number;
  /** Running subagents across this host at once. */
  maxRunningPerHost: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  maxDepth: 1,
  maxRunningPerParent: 4,
  maxRunningPerHost: 12,
};

export function createSubagentManager(
  sessions: SubagentSessions,
  store: SubagentStore,
  createChild?: SubagentCreator,
  limits: SubagentLimits = DEFAULT_SUBAGENT_LIMITS,
): SubagentManager {
  /** Resolve a child that belongs to `parentId` (scoping), else undefined. */
  const ownChild = (parentId: string, subagentId: string): SubagentConversation | undefined => {
    const c = sessions.get(subagentId as SessionId);
    // A session belongs to its person, not the parent agent.
    return c && c.parentId === parentId && c.kind === "subagent" ? c : undefined;
  };

  // In-flight spawns, so a parallel burst cannot overshoot: unnamed until the router mints an id.
  const unnamed = new Map<string, number>();
  const pending = new Map<string, string>(); // child id -> parent id
  const bump = (parentId: string, by: number) => {
    const left = (unnamed.get(parentId) ?? 0) + by;
    if (left > 0) unnamed.set(parentId, left);
    else unnamed.delete(parentId);
  };
  /** Busy or in-flight children, each counted once. */
  const inUse = (all: SubagentConversation[], parentId?: string): number => {
    const ids = new Set<string>();
    for (const c of all) if (subagentIsBusy(c) && (parentId === undefined || c.parentId === parentId)) ids.add(c.id);
    for (const [id, p] of pending) if (parentId === undefined || p === parentId) ids.add(id);
    let anon = 0;
    for (const [p, n] of unnamed) if (parentId === undefined || p === parentId) anon += n;
    return ids.size + anon;
  };

  return {
    async spawn(parentId, args) {
      // Checked before the router mints a row, so a refusal leaves nothing behind.
      const session = args.kind === "session";
      // Sessions are depth 0, so they may delegate too.
      let depth = 0;
      for (let c = sessions.get(parentId), hops = 0; c?.parentId && hops < 32; hops++) {
        if (c.kind !== "session") depth++;
        c = sessions.get(c.parentId as SessionId);
      }
      if (!session && depth >= limits.maxDepth) {
        throw new SubagentLimitError(
          `Not spawned: subagents nest at most ${limits.maxDepth} level(s) deep, and you are already a ` +
            `subagent. Do this work yourself in this turn.`,
        );
      }
      const all = sessions.list();
      const mine = inUse(all, parentId);
      if (mine >= limits.maxRunningPerParent) {
        throw new SubagentLimitError(
          `Not spawned: you already have ${mine} running subagents (limit ${limits.maxRunningPerParent}). ` +
            `Wait for one to finish, or do this work yourself.`,
        );
      }
      const host = inUse(all);
      if (host >= limits.maxRunningPerHost) {
        throw new SubagentLimitError(
          `Not spawned: this host is running ${host} subagents (limit ${limits.maxRunningPerHost}). ` +
            `Do this work yourself, or retry after yours finish.`,
        );
      }
      bump(parentId, 1);
      let childThreadId: string | undefined;
      try {
        // The router mints the id, before any event.
        childThreadId = createChild
          ? (await createChild(parentId, { title: args.title, model: args.model, kind: args.kind })).id
          : randomUUID();
        bump(parentId, -1);
        pending.set(childThreadId, parentId);
        const child = await sessions.spawnChild(parentId as SessionId, childThreadId, args);
        return { id: child.id, title: child.title };
      } finally {
        // Once spawned, the child counts itself via subagentIsBusy.
        if (childThreadId === undefined) bump(parentId, -1);
        else pending.delete(childThreadId);
      }
    },
    async list(parentId) {
      return sessions
        .list()
        .filter((c) => c.parentId === parentId && c.kind === "subagent")
        .map((c) => ({ id: c.id, title: c.title, status: subagentStatusOf(c) }));
    },
    async check(parentId, subagentId) {
      const c = ownChild(parentId, subagentId);
      if (!c) return undefined;
      return { id: c.id, title: c.title, status: subagentStatusOf(c) };
    },
    async cancel(parentId, subagentId) {
      const c = ownChild(parentId, subagentId);
      if (!c) return { outcome: "unknown" };
      if (!c.bridge) return { outcome: "already-idle" };
      c.bridge.cancel();
      return { outcome: "cancelled" };
    },
    async send(parentId, subagentId, message) {
      const c = ownChild(parentId, subagentId);
      if (!c) return { outcome: "unknown" };
      // Only a running child has a turn for a course correction to land on.
      if (subagentStatusOf(c) !== "running") return { outcome: "not-running" };
      // Preempt the child's current turn with the clarification, sourced as a system message from
      // the parent.
      await sessions.prompt(
        subagentId as SessionId,
        `[Clarification from your parent agent — factor this into your current work]\n\n${message}`,
        undefined,
        PRIORITY_INTERRUPT,
        "thinking",
        undefined,
        undefined,
        "parent-clarification",
      );
      return { outcome: "sent" };
    },
    async recentTurns(parentId, subagentId, n) {
      const c = ownChild(parentId, subagentId);
      if (!c) return undefined;
      const events = store.readEventsTail
        ? await store.readEventsTail(subagentId as SessionId, Math.max(2, Math.ceil(n / 2)))
        : await collect(store.readEvents(subagentId as SessionId));
      return foldTurnsWithTools(events).slice(-n);
    },
    async searchHistory(parentId, subagentId, query) {
      const c = ownChild(parentId, subagentId);
      if (!c) return undefined;
      const events = await collect(store.readEvents(subagentId as SessionId));
      const q = query.toLowerCase();
      return foldTurnsWithTools(events).filter((t) => t.text.toLowerCase().includes(q));
    },
  };
}
