/**
 * createSubagentManager — the SubagentManager impl, extracted from index.ts so the
 * spawn/list/check/cancel/send/monitor/search logic is unit-testable against a
 * controllable sessions + store (no real pod/bridge). See
 * todo/docs/SUBAGENT_INTERACTION.md.
 */

import { randomUUID } from "node:crypto";

import type { SessionId } from "../types.js";
import type { AguiEvent } from "../bridge.js";
import type { SubagentManager, SubagentStatus } from "../agent/subagentTools.js";
import { foldTurnsWithTools } from "../agent/subagentTranscript.js";
import { PRIORITY_INTERRUPT } from "../bridge.js";

/** The (minimal) child conversation shape the manager reasons about — a subset of
 *  SessionManager's Conversation. A running child has a bridge with a live run. */
export interface SubagentConversation {
  id: string;
  title?: string;
  parentId?: string;
  status?: string;
  bridge?: {
    queueState(): { running: boolean };
    cancel(): void;
  };
}

/** The bits of SessionManager the subagent manager drives (narrowed for testing). */
export interface SubagentSessions {
  get(id: SessionId): SubagentConversation | undefined;
  list(): SubagentConversation[];
  spawnChild(parentId: SessionId, childThreadId: string, args: { prompt: string; title?: string; model?: string }): Promise<{ id: string; title?: string }>;
  prompt(id: SessionId, text: string, model?: string, priority?: number, interrupt?: unknown, images?: unknown, files?: unknown, source?: string): Promise<void>;
}

/** The bits of the ConversationStore the manager reads (narrowed for testing). */
export interface SubagentStore {
  readEvents(id: SessionId): AsyncIterable<AguiEvent>;
  readEventsTail?(id: SessionId, runs: number): Promise<AguiEvent[]>;
}

/** A subagent's status as its parent sees it: ended (gone), else running (its
 *  bridge has a live run) or idle (spawned / finished a run, waiting). */
export function subagentStatusOf(c: SubagentConversation): SubagentStatus["status"] {
  if (c.status === "ended") return "ended";
  return c.bridge?.queueState().running ? "running" : "idle";
}

async function collect(it: AsyncIterable<AguiEvent>): Promise<AguiEvent[]> {
  const out: AguiEvent[] = [];
  try {
    for await (const e of it) out.push(e);
  } catch {
    /* a read failure yields what we have (best-effort transcript) */
  }
  return out;
}

export function createSubagentManager(sessions: SubagentSessions, store: SubagentStore): SubagentManager {
  /** Resolve a child that belongs to `parentId` (scoping), else undefined. */
  const ownChild = (parentId: string, subagentId: string): SubagentConversation | undefined => {
    const c = sessions.get(subagentId as SessionId);
    return c && c.parentId === parentId ? c : undefined;
  };

  return {
    async spawn(parentId, args) {
      const childThreadId = randomUUID();
      const child = await sessions.spawnChild(parentId as SessionId, childThreadId, args);
      return { id: child.id, title: child.title };
    },
    async list(parentId) {
      return sessions
        .list()
        .filter((c) => c.parentId === parentId)
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
      // Only interrupt a RUNNING child — a course correction has nothing to land on
      // if it's idle/ended (its result already returned to the parent).
      if (subagentStatusOf(c) !== "running") return { outcome: "not-running" };
      // Priority-interrupt "thinking": preempt the child's current turn with the
      // clarification (same path the parent-nudge uses). A SYSTEM message from the
      // parent, not a human turn — sourced so the UI renders it as such.
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
