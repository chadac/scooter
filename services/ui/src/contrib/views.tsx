/**
 * The surface a contrib view (`ui.views`) builds on: the same live stores, actions and
 * components the chat view uses, so a view lays them out its own way without fetching
 * anything twice. Re-exported from ./sdk, the only module a contrib may import.
 */

import { useMemo } from "react";

import { promptConversation } from "../client.js";
import { agentHostConfig } from "../config.js";
import { folderStore, moveTo, STARRED, useFolders as useFolderState } from "../folders.js";
import { sessionStore, turnDot, useSessions, type TurnDot } from "../sessions.js";
import { useRoute, viewStore } from "../view.js";

import { ChatPanel as Panel } from "../ChatPage.js";
import { RuntimeProvider } from "../RuntimeProvider.js";

/** The open conversation's thread, composer and approvals, as /chat/<id> shows them.
 *  Its own runtime, so switching conversations remounts the panel, not the view. */
export function ChatPanel(props: { conversationId?: string }) {
  return (
    <RuntimeProvider>
      <Panel {...props} />
    </RuntimeProvider>
  );
}
export { Sidebar as ConversationSidebar, StatusDot } from "../Sidebar.js";

/** Where a view is: its id, and the URL below `/<id>` without slashes at either end. */
export interface ViewRoute {
  viewId: string;
  path: string;
  /** Go to `path` within this view, adding a history entry. */
  navigate(path: string): void;
}

export function useViewRoute(): ViewRoute {
  const route = useRoute();
  const viewId = route.viewId ?? "";
  return useMemo(
    () => ({ viewId, path: route.viewPath ?? "", navigate: (p: string) => viewStore.openView(viewId, p) }),
    [viewId, route.viewPath],
  );
}

/** One top-level conversation the user can see, live from the conversation stream. */
export interface ViewConversation {
  /** The server's conversation id. */
  id: string;
  title: string;
  owner?: string;
  /** Last user activity (ms epoch). */
  lastActivityAt: number;
  /** The sandbox's lifecycle state. */
  status?: "running" | "suspended" | "failed" | "ended";
  /** Set while the agent is mid-turn. */
  running: boolean;
  /** The sidebar's status dot, or undefined when there is nothing to show. */
  dot?: TurnDot;
  /** The user's folder it is filed in; null when unfiled or Starred. */
  folderId: string | null;
}

/** Every top-level conversation the user can see, newest activity first. */
export function useConversations(): ViewConversation[] {
  const { sessions } = useSessions();
  const { placements } = useFolderState();
  return useMemo(
    () =>
      sessions
        .filter((s) => s.serverId !== undefined && !s.parentId)
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
        .map((s) => {
          const f = placements[s.serverId!];
          return {
            id: s.serverId!,
            title: s.title,
            owner: s.owner,
            lastActivityAt: s.lastActivityAt,
            status: s.status,
            running: s.runStartedAt !== undefined,
            dot: turnDot(s),
            folderId: f && f !== STARRED ? f : null,
          };
        }),
    [sessions, placements],
  );
}

/** The server id of the open conversation, or null for none or an unsent draft. */
export function useOpenConversation(): string | null {
  const { sessions, currentId } = useSessions();
  return sessions.find((s) => s.id === currentId)?.serverId ?? null;
}

/** One of the user's folders. */
export interface ViewFolder {
  id: string;
  name: string;
  /** A Lucide icon name, if the user set one. */
  icon?: string;
}

/** The user's folders in sidebar order, Starred left out. */
export function useFolders(): ViewFolder[] {
  const { folders } = useFolderState();
  return useMemo(
    () => folders.filter((f) => f.kind === "user").map((f) => ({ id: f.id, name: f.name, icon: f.icon })),
    [folders],
  );
}

/** Create a folder, resolving to its id, or null when the name is taken or invalid. */
export const createFolder = (name: string): Promise<string | null> => folderStore.create(name);

export const renameFolder = (id: string, name: string): Promise<boolean> => folderStore.rename(id, name);

const sessionOf = (id: string) => sessionStore.get().sessions.find((s) => s.serverId === id);

/** File a conversation in a folder, or take it out with null. */
export function moveToFolder(conversationId: string, folderId: string | null): Promise<boolean> {
  const s = sessionOf(conversationId);
  return s ? moveTo(s, folderId) : Promise.resolve(false);
}

/** Make a conversation the open one, where `<ChatPanel />` shows it. */
export function openConversation(conversationId: string): void {
  const s = sessionOf(conversationId);
  if (s) sessionStore.switchTo(s.id);
  else sessionStore.requestSelect(conversationId);
}

/** Open a conversation in the chat view, leaving this one. */
export function openInChat(conversationId: string): void {
  viewStore.set("chat");
  openConversation(conversationId);
}

/** Open a fresh draft, filed in `folderId` once sent; `<ChatPanel />` shows its composer. */
export function newConversation(opts: { folderId?: string } = {}): void {
  folderStore.newIn(opts.folderId ?? null);
}

/** Send a message to a conversation as the user, starting a run; resolves false on failure. */
export const send = (conversationId: string, text: string): Promise<boolean> =>
  promptConversation(agentHostConfig, conversationId, text);

/**
 * Call this contrib's broker routes for any conversation the user can see, as the user.
 * Needs `api = true` on a tab, panel or view. Reaches `/<contrib>/conversation/<key>/<path>`.
 */
export function conversationApi(
  contrib: string,
  conversationId: string,
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("Content-Type", "application/json");
  const base = agentHostConfig.baseUrl.replace(/\/$/, "");
  const url = `${base}/conversations/${encodeURIComponent(conversationId)}/contrib-api/${encodeURIComponent(contrib)}/${path.replace(/^\/+/, "")}`;
  return fetch(url, {
    ...rest,
    headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
    credentials: "same-origin",
  });
}
