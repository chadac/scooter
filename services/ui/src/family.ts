/**
 * A conversation's family: the top-level conversation that owns a sandbox, the sessions people
 * started in it and the subagents its agents spawned. Every member shares the sandbox, so the
 * chat switcher and the Chats panel list a family together.
 */

import { serverKeyOf, type Session } from "./sessions.js";

export interface FamilyMember {
  session: Session;
  /** 0 for the root, 1 for its children, and so on. */
  depth: number;
}

/** The top-level conversation `id` (a local key or server id) belongs to, if listed. */
export function rootOf(sessions: Session[], id: string | undefined): Session | undefined {
  if (!id) return undefined;
  const byServerId = new Map(sessions.map((s) => [serverKeyOf(s), s]));
  let cur = sessions.find((s) => s.id === id) ?? byServerId.get(id);
  // Bounded, so a parent cycle in bad data cannot hang the page.
  for (let hops = 0; cur?.parentId && hops < 32; hops++) {
    const parent = byServerId.get(cur.parentId);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

// Sessions first, since a person drives them; oldest first within each kind.
const childOrder = (a: Session, b: Session): number =>
  Number(a.kind !== "session") - Number(b.kind !== "session") || a.createdAt - b.createdAt;

/** The root of `id`'s family followed by its descendants, depth-first. */
export function familyOf(sessions: Session[], id: string | undefined): FamilyMember[] {
  const root = rootOf(sessions, id);
  if (!root) return [];
  const childrenOf = new Map<string, Session[]>();
  for (const s of sessions) {
    if (s.parentId) (childrenOf.get(s.parentId) ?? childrenOf.set(s.parentId, []).get(s.parentId)!).push(s);
  }
  const out: FamilyMember[] = [];
  const seen = new Set<string>();
  const walk = (s: Session, depth: number) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    out.push({ session: s, depth });
    for (const c of (childrenOf.get(serverKeyOf(s)) ?? []).sort(childOrder)) walk(c, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** How many members are mid-turn, and how many wait on the user. */
export function familyActivity(members: FamilyMember[]): { running: number; awaiting: number } {
  let running = 0;
  let awaiting = 0;
  for (const { session: s } of members) {
    if (s.awaitingInputAt !== undefined) awaiting++;
    else if (s.runStartedAt !== undefined && (s.status === undefined || s.status === "running")) running++;
  }
  return { running, awaiting };
}

/** Whether `user` may start a session in `root`'s sandbox now: its owner, while it runs. */
export const canStartSession = (
  root: Session | undefined,
  user: { id: string; anonymous: boolean },
): root is Session =>
  !!root &&
  !root.parentId &&
  root.serverId !== undefined &&
  root.status === "running" &&
  // Anonymous is single-user mode; the server still decides.
  (!root.owner || root.owner === user.id || user.anonymous);
