/**
 * The sidebar's per-conversation actions: star, rename, delete.
 *
 * They live here rather than inline in the row because each one spans TWO identities.
 * A Session's `id` is its stable LOCAL key — for a conversation started in this browser
 * it is a placeholder the server has never issued (adoptServerId records the real id in
 * `serverId` and deliberately leaves the key alone). The store is keyed by the key; the
 * SERVER must be addressed by `serverId`. Mixing them 404s. Why: PR #501.
 */

import { deleteConversation, renameConversation, setConversationStarred } from "./client.js";
import { agentHostConfig } from "./config.js";
import { conversationFor, sessionStore, type Session } from "./sessions.js";

/** The server's id for a session, or undefined when the server has never created it.
 *  Goes through Conversation so ONE object decides how a conversation is addressed. */
const serverIdOf = (s: Session): string | undefined =>
  conversationFor(s).serverId();

/** Does this conversation exist server-side? False for an unsent "New chat", whose
 *  server-owned state (the star) cannot be set yet. */
export const isServerBacked = (s: Session): boolean => serverIdOf(s) !== undefined;

/**
 * Star / unstar. `starred` is server-owned, so a conversation the server has not created
 * has nothing to star — the control is disabled for those rather than lying locally.
 */
export async function toggleStar(s: Session): Promise<void> {
  const id = serverIdOf(s);
  if (id === undefined) return;
  const next = !s.starred;
  sessionStore.setStarred(s.id, next); // optimistic, by LOCAL key
  const updated = await setConversationStarred(agentHostConfig, id, next);
  if (updated) return;
  // Revert: without this a failed write leaves the star lit until the 10s merge poll
  // quietly drops it, which reads as "starring randomly doesn't stick".
  // Only if the user has not toggled again since — theirs wins over our rollback.
  if (sessionStore.get().sessions.find((x) => x.id === s.id)?.starred === next) {
    sessionStore.setStarred(s.id, !next);
  }
}

/**
 * Commit an inline rename. The local title applies either way (it is what the row
 * renders); the durable write only happens once the conversation exists server-side.
 */
export async function commitRename(s: Session, title: string): Promise<void> {
  const next = title.trim();
  if (!next || next === s.title) return;
  sessionStore.renameSession(s.id, next); // optimistic + lock, by LOCAL key
  const id = serverIdOf(s);
  if (id === undefined) return;
  await renameConversation(agentHostConfig, id, next);
}

/**
 * Delete: destroys the sandbox + data server-side. A never-created conversation is
 * local-only, so dropping the row IS the whole delete.
 */
export async function removeSession(s: Session): Promise<void> {
  const id = serverIdOf(s);
  sessionStore.deleteSession(s.id); // optimistic local removal, by LOCAL key
  if (id === undefined) return;
  await deleteConversation(agentHostConfig, id);
}
