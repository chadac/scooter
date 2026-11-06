/** The viewer's sidebar folders, owned by the router, applied optimistically. */

import { useSyncExternalStore } from "react";

import {
  createFolder,
  deleteFolder,
  fetchFolders,
  placeConversation,
  updateFolder,
  type ConversationFolder,
} from "./client.js";
import { agentHostConfig } from "./config.js";
import { serverIdOf } from "./sessionActions.js";
import { serverKeyOf, sessionStore, type Session, type SidebarRow } from "./sessions.js";

export const STARRED = "starred";

const STARRED_FOLDER: ConversationFolder = { id: STARRED, name: "Starred", kind: "starred", position: 0 };

export type FolderState = {
  /** Starred first, then the user's folders in position order. */
  folders: ConversationFolder[];
  /** Server conversation id → folder id. */
  placements: Record<string, string>;
  collapsed: Record<string, boolean>;
};

const COLLAPSED_KEY = "scooter.folders.collapsed.v1";

const loadCollapsed = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
};

let state: FolderState = { folders: [STARRED_FOLDER], placements: {}, collapsed: loadCollapsed() };
const listeners = new Set<() => void>();

const set = (next: FolderState) => {
  const starsChanged = next.placements !== state.placements;
  state = next;
  if (starsChanged) {
    const keys = Object.keys(next.placements).filter((id) => next.placements[id] === STARRED);
    sessionStore.setStarredKeys(new Set(keys));
  }
  for (const l of listeners) l();
};

const userFolders = () => state.folders.filter((f) => f.kind === "user");

// Each load bumps this, so a slow response never overwrites a newer one.
let loadSeq = 0;

/** Apply a write optimistically, refetching when the server rejects it. */
async function write(next: FolderState, persist: () => Promise<boolean>): Promise<boolean> {
  set(next);
  const ok = await persist();
  if (!ok) await folderStore.load();
  return ok;
}

export const folderStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },

  /** Refetch on every list snapshot and `folders` frame. */
  async load(): Promise<void> {
    const seq = ++loadSeq;
    const got = await fetchFolders(agentHostConfig);
    if (!got || seq !== loadSeq) return;
    set({ ...state, folders: got.folders, placements: got.placements });
  },

  /** Create a folder, resolving to its id or null (a taken name included). */
  async create(name: string): Promise<string | null> {
    const n = name.trim();
    if (!n) return null;
    const f = await createFolder(agentHostConfig, n);
    if (!f) return null;
    if (!state.folders.some((x) => x.id === f.id)) set({ ...state, folders: [...state.folders, f] });
    return f.id;
  },

  rename(id: string, name: string): Promise<boolean> {
    const n = name.trim();
    if (!n || id === STARRED) return Promise.resolve(false);
    const folders = state.folders.map((f) => (f.id === id ? { ...f, name: n } : f));
    return write({ ...state, folders }, () => updateFolder(agentHostConfig, id, { name: n }));
  },

  /** Delete a folder; its conversations go back to Recent. */
  remove(id: string): Promise<boolean> {
    if (id === STARRED) return Promise.resolve(false);
    const placements = Object.fromEntries(Object.entries(state.placements).filter(([, f]) => f !== id));
    const folders = state.folders.filter((f) => f.id !== id);
    return write({ ...state, folders, placements }, () => deleteFolder(agentHostConfig, id));
  },

  /** Move a user folder before `beforeId`, else last. */
  reorder(id: string, beforeId?: string): Promise<boolean> {
    const moving = userFolders().find((f) => f.id === id);
    if (!moving || id === beforeId) return Promise.resolve(false);
    const rest = userFolders().filter((f) => f.id !== id);
    const at = rest.findIndex((f) => f.id === beforeId);
    const index = at < 0 ? rest.length : at;
    const position = positionBetween(rest[index - 1]?.position, rest[index]?.position);
    rest.splice(index, 0, { ...moving, position });
    return write({ ...state, folders: [STARRED_FOLDER, ...rest] }, () =>
      updateFolder(agentHostConfig, id, { position }),
    );
  },

  toggleCollapsed(id: string) {
    const collapsed = { ...state.collapsed, [id]: !state.collapsed[id] };
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed));
    } catch {
      // Private mode: collapse just won't persist.
    }
    set({ ...state, collapsed });
  },
};

/** A position between two neighbors, either possibly missing. */
export function positionBetween(before?: number, after?: number): number {
  if (before !== undefined && after !== undefined) return (before + after) / 2;
  if (before !== undefined) return before + 1;
  if (after !== undefined) return after - 1;
  return 1;
}

/** File a conversation (STARRED stars it); null returns it to Recent. */
export function moveTo(s: Session, folderId: string | null): Promise<boolean> {
  const id = serverIdOf(s);
  // An unsent conversation has no row to file yet.
  if (id === undefined || s.parentId) return Promise.resolve(false);
  const { [id]: _, ...rest } = state.placements;
  const placements = folderId ? { ...rest, [id]: folderId } : rest;
  return write({ ...state, placements }, () => placeConversation(agentHostConfig, id, folderId));
}

/** The conversation's folder id, or null for Recent. */
export const folderOf = (s: Session): string | null => {
  const f = state.placements[serverKeyOf(s)];
  return f && state.folders.some((x) => x.id === f) ? f : null;
};

export const useFolders = () => useSyncExternalStore(folderStore.subscribe, folderStore.get, folderStore.get);

export type FolderSection = { id: string; name: string; builtin: boolean; rows: SidebarRow[] };

/** Section the rows; subagents follow parents, duplicates render once. */
export function buildFolders(rows: SidebarRow[], fs: FolderState): { folders: FolderSection[]; recent: SidebarRow[] } {
  const sections: FolderSection[] = fs.folders.map((f) => ({ id: f.id, name: f.name, builtin: f.kind === "starred", rows: [] }));
  const byId = new Map(sections.map((s) => [s.id, s.rows]));
  const recent: SidebarRow[] = [];
  const seen = new Set<string>();
  // undefined: a duplicate parent, so its children drop too.
  let bucket: SidebarRow[] | undefined = recent;
  for (const r of rows) {
    const key = serverKeyOf(r.session);
    if (r.depth === 0) bucket = seen.has(key) ? undefined : (byId.get(fs.placements[key]) ?? recent);
    if (!bucket || seen.has(key)) continue;
    seen.add(key);
    bucket.push(r);
  }
  return { folders: sections, recent };
}
