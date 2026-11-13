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
import { serverKeyOf, sessionStore, setAfterCreate, type Session, type SidebarRow } from "./sessions.js";

export const STARRED = "starred";

/** Folders nest this deep; a top-level folder is depth 1. */
export const MAX_FOLDER_DEPTH = 3;

const STARRED_FOLDER: ConversationFolder = { id: STARRED, name: "Starred", kind: "starred", locked: true, position: 0, conversationLifetimeHours: 0 };

export type FolderState = {
  /** Starred, then user folders by position. */
  folders: ConversationFolder[];
  /** Server conversation id → folder id. */
  placements: Record<string, string>;
  collapsed: Record<string, boolean>;
  /** Unsent conversation key → the folder it was started in. */
  drafts: Record<string, string>;
  /** The deployment's lifetime for unfiled conversations; undefined until known. */
  defaultLifetimeHours?: number;
};

/** Where a dragged folder lands relative to a target. */
export type DropPlace = "before" | "after" | "into";

const COLLAPSED_KEY = "scooter.folders.collapsed.v1";

const loadCollapsed = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
};

let state: FolderState = { folders: [STARRED_FOLDER], placements: {}, collapsed: loadCollapsed(), drafts: {} };
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

const byId = (id: string) => state.folders.find((f) => f.id === id);
const isUser = (f?: ConversationFolder): f is ConversationFolder => f?.kind === "user";
/** A folder its user may move, rename or nest in. */
const isOpen = (f?: ConversationFolder): f is ConversationFolder => isUser(f) && !f.locked;
/** A user folder's siblings, in order; "" is the top level. */
const siblings = (parentId: string) => state.folders.filter((f) => isUser(f) && (f.parentId ?? "") === parentId);

/** A user folder's level, 1 at the top; 0 if unknown. */
export function folderDepth(id: string, folders = state.folders): number {
  let depth = 0;
  for (let f = folders.find((x) => x.id === id); f && depth <= MAX_FOLDER_DEPTH; f = folders.find((x) => x.id === f!.parentId)) depth++;
  return depth;
}

/** Levels in a folder's subtree, counting itself. */
function folderHeight(id: string): number {
  const kids = state.folders.filter((f) => f.parentId === id);
  return 1 + Math.max(0, ...kids.map((k) => folderHeight(k.id)));
}

/** Whether `id` may move into `parentId` (null: the top level). */
export function canMoveInto(id: string, parentId: string | null): boolean {
  if (!isOpen(byId(id))) return false;
  if (parentId === null) return true;
  if (!isOpen(byId(parentId))) return false;
  for (let p: string | undefined = parentId; p; p = byId(p)?.parentId) if (p === id) return false;
  return folderDepth(parentId) + folderHeight(id) <= MAX_FOLDER_DEPTH;
}

/** The nearest set lifetime and its folder; undefined is the default. */
export function effectiveLifetime(id: string): { hours: number; from: ConversationFolder } | undefined {
  for (let f = byId(id); f; f = f.parentId ? byId(f.parentId) : undefined) {
    if (f.conversationLifetimeHours !== undefined && f.conversationLifetimeHours !== null) return { hours: f.conversationLifetimeHours, from: f };
  }
  return undefined;
}

// Each load bumps this, so a slow response never overwrites a newer one.
let loadSeq = 0;

/** Apply a write optimistically, refetching when the server rejects it. */
async function write(next: FolderState, persist: () => Promise<boolean>): Promise<boolean> {
  set(next);
  const ok = await persist();
  if (!ok) await folderStore.load();
  return ok;
}

/** Replace one folder's fields. */
const patched = (id: string, patch: Partial<ConversationFolder>) =>
  state.folders.map((f) => (f.id === id ? { ...f, ...patch } : f));

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

  /** Create a folder, optionally nested; resolves to its id or null. */
  async create(name: string, parentId?: string): Promise<string | null> {
    const n = name.trim();
    if (!n || (parentId && folderDepth(parentId) >= MAX_FOLDER_DEPTH)) return null;
    const f = await createFolder(agentHostConfig, n, parentId);
    if (!f) return null;
    if (!state.folders.some((x) => x.id === f.id)) set({ ...state, folders: [...state.folders, f] });
    return f.id;
  },

  rename(id: string, name: string): Promise<boolean> {
    const n = name.trim();
    if (!n || !isOpen(byId(id))) return Promise.resolve(false);
    return write({ ...state, folders: patched(id, { name: n }) }, () => updateFolder(agentHostConfig, id, { name: n }));
  },

  /** Set a folder's Lucide icon; "" restores the folder glyph. */
  setIcon(id: string, icon: string): Promise<boolean> {
    if (!isOpen(byId(id))) return Promise.resolve(false);
    const i = icon.trim();
    return write({ ...state, folders: patched(id, { icon: i || undefined }) }, () => updateFolder(agentHostConfig, id, { icon: i }));
  },

  /** Record the default lifetime from /whoami. */
  setDefaultLifetime(hours: number | undefined) {
    if (state.defaultLifetimeHours !== hours) set({ ...state, defaultLifetimeHours: hours });
  },

  /** Set idle lifetime hours; 0 is forever, null inherits. */
  setLifetime(id: string, hours: number | null): Promise<boolean> {
    if (!isOpen(byId(id))) return Promise.resolve(false);
    const folders = patched(id, { conversationLifetimeHours: hours ?? undefined });
    return write({ ...state, folders }, () => updateFolder(agentHostConfig, id, { conversationLifetimeHours: hours }));
  },

  /** Start a conversation in `folderId`; null means Recent. */
  newIn(folderId: string | null): string {
    const key = sessionStore.startFresh();
    const { [key]: _, ...rest } = state.drafts;
    set({ ...state, drafts: folderId ? { ...rest, [key]: folderId } : rest });
    return key;
  },

  /** Delete a folder, lifting its contents; `subfolders` drops them instead. */
  remove(id: string, subfolders = false): Promise<boolean> {
    const f = byId(id);
    if (!isOpen(f)) return Promise.resolve(false);
    const gone = new Set([id]);
    if (subfolders) {
      for (let grew = true; grew; ) {
        grew = false;
        for (const x of state.folders) {
          if (!x.parentId || !gone.has(x.parentId) || gone.has(x.id)) continue;
          gone.add(x.id);
          grew = true;
        }
      }
    }
    const lifted = subfolders ? undefined : f.parentId;
    const placements: Record<string, string> = {};
    for (const [conv, folder] of Object.entries(state.placements)) {
      if (!gone.has(folder)) placements[conv] = folder;
      else if (lifted) placements[conv] = lifted;
    }
    const folders = state.folders
      .filter((x) => !gone.has(x.id))
      .map((x) => (x.parentId === id ? { ...x, parentId: f.parentId } : x));
    return write({ ...state, folders, placements }, () => deleteFolder(agentHostConfig, id, subfolders));
  },

  /** Move a folder beside or into another; Starred: top. */
  reorder(id: string, targetId: string, place: DropPlace = "before"): Promise<boolean> {
    const moving = byId(id);
    const target = byId(targetId);
    if (!isOpen(moving) || !target || id === targetId) return Promise.resolve(false);
    let parentId: string;
    let index: number;
    if (!isUser(target)) {
      parentId = "";
      index = 0;
    } else if (place === "into") {
      parentId = targetId;
      index = siblings(targetId).filter((f) => f.id !== id).length;
    } else {
      parentId = target.parentId ?? "";
      index = siblings(parentId).filter((f) => f.id !== id).findIndex((f) => f.id === targetId) + (place === "after" ? 1 : 0);
    }
    if (!canMoveInto(id, parentId || null)) return Promise.resolve(false);
    const rest = siblings(parentId).filter((f) => f.id !== id);
    const sameParent = (moving.parentId ?? "") === parentId;
    if (sameParent && siblings(parentId).findIndex((f) => f.id === id) === index) return Promise.resolve(false);
    const position = positionBetween(rest[index - 1]?.position, rest[index]?.position);
    const folders = patched(id, { position, parentId: parentId || undefined }).sort(folderOrder);
    return write({ ...state, folders }, () =>
      updateFolder(agentHostConfig, id, sameParent ? { position } : { position, parentId }),
    );
  },

  /** Append a folder to `parentId`; null is the top level. */
  moveInto(id: string, parentId: string | null): Promise<boolean> {
    const f = byId(id);
    if (!isOpen(f) || (f.parentId ?? null) === parentId || !canMoveInto(id, parentId)) return Promise.resolve(false);
    const last = siblings(parentId ?? "").at(-1);
    const position = positionBetween(last?.position, undefined);
    const folders = patched(id, { position, parentId: parentId ?? undefined }).sort(folderOrder);
    return write({ ...state, folders }, () => updateFolder(agentHostConfig, id, { position, parentId: parentId ?? "" }));
  },

  /** Move a folder up (-1) or down (1) among siblings. */
  nudge(id: string, by: -1 | 1): Promise<boolean> {
    const sibs = siblings(byId(id)?.parentId ?? "");
    const next = sibs[sibs.findIndex((f) => f.id === id) + by];
    return next ? folderStore.reorder(id, next.id, by > 0 ? "after" : "before") : Promise.resolve(false);
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

/** Static folders keep their order first; user folders sort by position. */
const folderOrder = (a: ConversationFolder, b: ConversationFolder) =>
  isUser(a) && isUser(b) ? a.position - b.position : isUser(a) ? 1 : isUser(b) ? -1 : 0;

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
  const f = state.placements[serverKeyOf(s)] ?? state.drafts[s.id];
  return f && state.folders.some((x) => x.id === f) ? f : null;
};

/** A folder's name with its ancestors, like "Work / Scooter". */
export function folderPath(id: string, folders = state.folders): string {
  const names: string[] = [];
  for (let f = folders.find((x) => x.id === id); f && names.length <= MAX_FOLDER_DEPTH; f = folders.find((x) => x.id === f!.parentId))
    names.unshift(f.name);
  return names.join(" / ");
}

// File a conversation started in a folder before its create resolves: the first send waits on
// the create, and its run reads the folder for the kanban hooks and board skills (#1361). The
// draft stays until the id is adopted so the row never drops to Recent in between.
setAfterCreate(async (key, id) => {
  const folderId = state.drafts[key];
  if (!folderId) return;
  await write({ ...state, placements: { ...state.placements, [id]: folderId } }, () =>
    placeConversation(agentHostConfig, id, folderId),
  );
});

// File drafts once sent (unless filed at create); forget discarded ones.
sessionStore.subscribe(() => {
  const keys = Object.keys(state.drafts);
  if (keys.length === 0) return;
  const { sessions } = sessionStore.get();
  const drafts = { ...state.drafts };
  const sent: [Session, string][] = [];
  for (const key of keys) {
    const s = sessions.find((x) => x.id === key);
    if (s && serverIdOf(s) === undefined) continue;
    if (s && state.placements[serverKeyOf(s)] !== drafts[key]) sent.push([s, drafts[key]]);
    delete drafts[key];
  }
  if (sent.length === 0 && Object.keys(drafts).length === keys.length) return;
  // Drop drafts first: filing re-emits sessions, re-entering here.
  set({ ...state, drafts });
  for (const [s, folderId] of sent) void moveTo(s, folderId);
});

export const useFolders = () => useSyncExternalStore(folderStore.subscribe, folderStore.get, folderStore.get);

export type FolderSection = {
  id: string;
  name: string;
  icon?: string;
  /** Starred, which the star button fills. */
  starred: boolean;
  /** Starred or service-managed: no menu, drag or subfolders. */
  locked: boolean;
  depth: number;
  /** This folder's own lifetime; undefined inherits. */
  conversationLifetimeHours?: number;
  rows: SidebarRow[];
  children: FolderSection[];
};

/** Section rows into a folder tree; duplicates render once. */
export function buildFolders(rows: SidebarRow[], fs: FolderState): { folders: FolderSection[]; recent: SidebarRow[] } {
  const all = new Map<string, FolderSection>();
  for (const f of fs.folders) {
    all.set(f.id, {
      id: f.id,
      name: f.name,
      icon: f.icon,
      starred: f.kind === "starred",
      locked: !!f.locked,
      depth: folderDepth(f.id, fs.folders),
      conversationLifetimeHours: f.conversationLifetimeHours ?? undefined,
      rows: [],
      children: [],
    });
  }
  const roots: FolderSection[] = [];
  for (const f of fs.folders) {
    const parent = f.parentId ? all.get(f.parentId) : undefined;
    (parent ? parent.children : roots).push(all.get(f.id)!);
  }
  const recent: SidebarRow[] = [];
  const seen = new Set<string>();
  // undefined: a duplicate parent, so its children drop too.
  let bucket: SidebarRow[] | undefined = recent;
  for (const r of rows) {
    const key = serverKeyOf(r.session);
    if (r.depth === 0) bucket = seen.has(key) ? undefined : (all.get(fs.placements[key] ?? fs.drafts[r.session.id])?.rows ?? recent);
    if (!bucket || seen.has(key)) continue;
    seen.add(key);
    bucket.push(r);
  }
  return { folders: roots, recent };
}

/** Every row in a section and its subfolders. */
export function allRows(f: FolderSection): SidebarRow[] {
  return [...f.rows, ...f.children.flatMap(allRows)];
}

/** `currentId`'s row and its ancestors; empty if absent. */
export function currentBranch(rows: SidebarRow[], currentId: string): SidebarRow[] {
  const at = rows.findIndex((r) => r.session.id === currentId);
  if (at < 0) return [];
  const branch = [rows[at]];
  for (let i = at - 1; i >= 0 && branch[0].depth > 0; i--) {
    if (rows[i].depth < branch[0].depth) branch.unshift(rows[i]);
  }
  return branch;
}
