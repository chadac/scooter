/**
 * The current conversation's actions in the header: star, rename, delete. Each one spans two
 * identities: a Session's `id` is its stable local key (a placeholder for a conversation
 * started in this browser), while the server must be addressed by `serverId`.
 */

import { createSession, deleteConversation, type SessionSeedMode, renameConversation, setConversationVisibility } from "./client.js";
import { agentHostConfig } from "./config.js";
import { conversationFor, sessionStore, type Session } from "./sessions.js";

/** The server's id for a session, or undefined when the server has never created it. */
export const serverIdOf = (s: Session): string | undefined =>
  conversationFor(s).serverId();

/** Whether the conversation exists server-side; false for an unsent "New chat". */
export const isServerBacked = (s: Session): boolean => serverIdOf(s) !== undefined;

/** Commit an inline rename; the local title applies either way, the durable write only once the conversation exists server-side. */
export async function commitRename(s: Session, title: string): Promise<void> {
  const next = title.trim();
  if (!next || next === s.title) return;
  sessionStore.renameSession(s.id, next); // optimistic + lock, by local key
  const id = serverIdOf(s);
  if (id === undefined) return;
  await renameConversation(agentHostConfig, id, next);
}

/** Delete the sandbox and data server-side; a never-created conversation is local-only, so dropping the row is the whole delete. */
export async function removeSession(s: Session): Promise<void> {
  const conv = conversationFor(s);
  const creating = conv.creating;
  sessionStore.deleteSession(s.id); // optimistic local removal, by local key
  // Mid-create, wait for the id rather than leave a server conversation with no row to delete it from.
  const id = conv.serverId() ?? (creating ? await conv.ensureCreated() : null);
  if (!id) return;
  await deleteConversation(agentHostConfig, id);
}

/** The warning shown before a private conversation is made shared; going shared exposes what Scooter fetched while it was private. */
export const MAKE_SHARED_WARNING =
  "Other users will be able to read this conversation's history and open its terminal and files, " +
  "including anything Scooter fetched as you (cloned repos, mail, documents). Make it shared?";

/** Whether the signed-in user may change this conversation's visibility: its owner, on a top-level conversation the server has created. */
export const canChangeVisibility = (s: Session, currentUser: string, anonymous: boolean): boolean =>
  isServerBacked(s) && !s.parentId && !anonymous && !!currentUser && s.owner === currentUser;

/** Make a conversation private, or shared after the user confirms the warning; reverts the optimistic change when the server refuses. */
export async function toggleVisibility(s: Session, confirmShared: (msg: string) => boolean = (m) => window.confirm(m)): Promise<void> {
  const id = serverIdOf(s);
  if (id === undefined) return;
  const current = s.visibility ?? "shared";
  const next = current === "private" ? "shared" : "private";
  if (next === "shared" && !confirmShared(MAKE_SHARED_WARNING)) return;
  sessionStore.setVisibility(s.id, next); // optimistic, by local key
  const updated = await setConversationVisibility(agentHostConfig, id, next, next === "shared");
  if (updated) return;
  if ((sessionStore.get().sessions.find((x) => x.id === s.id)?.visibility ?? "shared") === next) {
    sessionStore.setVisibility(s.id, current);
  }
}

/** The confirm text before the owner clears a taint. */
export const clearTaintWarning = (labels: string[]): string =>
  "Clear the taint? You vouch for the text these authors wrote:\n\n" +
  [...new Set(labels)].map((l) => `• ${l}`).join("\n") +
  "\n\nIt stays in the agent's context and could steer it while it uses your SSH key, commit " +
  "identity and forge tokens. Anything they write later taints the conversation again.";

/** Start a web session in `root`'s sandbox and select it once listed; returns an error or null. */
export async function startSession(
  root: Session,
  select: (id: string) => void = (id) => sessionStore.requestSelect(id),
  seed: SessionSeedMode = "blank",
): Promise<string | null> {
  const parentId = serverIdOf(root);
  if (parentId === undefined) return "this conversation has not started yet";
  const res = await createSession(agentHostConfig, parentId, seed);
  if ("error" in res) return res.error;
  select(res.id);
  return null;
}
