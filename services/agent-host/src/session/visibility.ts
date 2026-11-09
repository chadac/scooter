/**
 * Conversation visibility: who may see and drive a conversation. Mirrors canAccess in
 * services/conversation-router/visibility.go; test/fixtures/visibility-cases.json pins both.
 */

export type Visibility = "shared" | "private";

/** A child's kind: agent-spawned "subagent" or person-driven "session". */
export type ConversationKind = "subagent" | "session";

export const VISIBILITIES: readonly Visibility[] = ["shared", "private"];

export function isVisibility(v: unknown): v is Visibility {
  return v === "shared" || v === "private";
}

/** The access facts for one conversation. */
export interface AccessFacts {
  owner?: string;
  visibility?: Visibility;
}

/**
 * Whether `caller` may see or act on the conversation. A private conversation admits its owner
 * alone, never an anonymous caller: private rows always have an owner, and a request that lost
 * its identity on a multi-user deployment must not read as "everyone".
 */
export function canAccess(conv: AccessFacts, caller: { anonymous: boolean; id: string } | undefined): boolean {
  if (conv.visibility !== "private") return true;
  return !!caller && !caller.anonymous && !!caller.id && conv.owner === caller.id;
}
