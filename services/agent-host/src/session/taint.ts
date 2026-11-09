/**
 * Why a private conversation acts as nobody, and how its owner clears that.
 *
 * Every author in the tree other than the owner taints it (see authorStore.ts). Clearing
 * moves the authors the owner was shown into a history table, vouching for their text.
 */

import type { AguiEvent } from "../bridge.js";
import type { AuthorStore, ResolvedAuthor, ShownAuthor } from "./authorStore.js";

/** The approval-card contrib name of an untaint request. */
export const UNTAINT_CONTRIB = "untaint";

/** Card metadata, so the answer clears exactly what it showed. */
export interface UntaintRequest {
  authors: ShownAuthor[];
  reason: string;
}

/** The authors that keep the tree from acting as `owner`. */
export function taintingAuthors(authors: ResolvedAuthor[], owner: string | undefined): ResolvedAuthor[] {
  return authors.filter((a) => !owner || a.user !== owner);
}

/** One author as the owner reads it, e.g. "@someone (github)". */
export function describeAuthor(a: Pick<ResolvedAuthor, "kind" | "author" | "provider" | "handle">): string {
  if (a.kind === "user") return `user ${a.author}`;
  if (a.kind === "identity") return a.handle ? `@${a.handle} (${a.provider ?? "unknown system"})` : `account ${a.author}`;
  return "unattributed text";
}

/** Every distinct author as one phrase: "a, b, and c". */
export function describeTaint(authors: ResolvedAuthor[]): string {
  const names = [...new Set(authors.map(describeAuthor))];
  if (names.length <= 2) return names.join(" and ");
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

/** A clear's rows, narrowed to those `current` holds. */
export function shownRows(shown: ShownAuthor[], current: ResolvedAuthor[]): ShownAuthor[] {
  const key = (a: Pick<ShownAuthor, "conversationId" | "kind" | "author">) => `${a.conversationId}\0${a.kind}\0${a.author}`;
  const known = new Set(current.map(key));
  return shown.filter((s) => known.has(key(s)));
}

/** A request body's author rows; undefined when malformed. */
export function parseShown(v: unknown): ShownAuthor[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ShownAuthor[] = [];
  for (const r of v as Array<Record<string, unknown> | null>) {
    if (!r || typeof r.conversationId !== "string" || typeof r.author !== "string") return undefined;
    if (r.kind !== "identity" && r.kind !== "user" && r.kind !== "unknown") return undefined;
    if (typeof r.lastAt !== "number" || !Number.isFinite(r.lastAt)) return undefined;
    out.push({ conversationId: r.conversationId, kind: r.kind, author: r.author, lastAt: r.lastAt });
  }
  return out;
}

/** The untaint request card `id` raised, answered or not. */
export function untaintRequestOf(events: AguiEvent[], id: string): UntaintRequest | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "RUN_FINISHED" || e.outcome?.type !== "interrupt") continue;
    const raised = e.outcome.interrupts.find((x) => x.id === id);
    if (!raised) continue;
    const req = raised.metadata?.untaint as { authors?: unknown; reason?: unknown } | undefined;
    const authors = parseShown(req?.authors);
    return authors && typeof req?.reason === "string" ? { authors, reason: req.reason } : undefined;
  }
  return undefined;
}

/** The card's text: what the owner vouches for, and why the agent asks. */
export function untaintMessage(authors: ResolvedAuthor[], reason: string): string {
  return (
    `The agent asks you to clear this conversation's taint, so it can use your credentials ` +
    `(SSH key, commit identity, forge tokens). It is tainted by ${describeTaint(authors)}. ` +
    `Clearing means you vouch for that text: it stays in the agent's context and could steer ` +
    `it while it acts as you.\n\nThe agent's reason: ${reason}`
  );
}

/** What answering an untaint card needs from the agent-host. */
export interface UntaintAnswerDeps {
  /** Owner and visibility; undefined for an unknown conversation. */
  access(conversationId: string): Promise<{ owner?: string; visibility?: string } | undefined>;
  events(conversationId: string): Promise<AguiEvent[]>;
  store: Pick<AuthorStore, "clear" | "listTree">;
  /** Tell the agent the outcome. */
  tell(conversationId: string, text: string): void;
}

/** Applies the owner's answer to an untaint card, then tells the agent. */
export async function answerUntaint(
  deps: UntaintAnswerDeps,
  conversationId: string,
  requestId: string,
  optionId: string,
  approver: { id: string },
): Promise<void> {
  const access = await deps.access(conversationId);
  const owner = access?.owner;
  if (!owner || approver.id !== owner) throw new Error("only the conversation's owner can clear its taint");
  if (optionId !== "approve") {
    deps.tell(conversationId, "The owner declined to clear this conversation's taint, so it still acts as nobody. Don't ask again unless they say to.");
    return;
  }
  if (access.visibility !== "private") throw new Error("only a private conversation's taint can be cleared");
  const request = untaintRequestOf(await deps.events(conversationId), requestId);
  if (!request) throw new Error(`untaint request ${requestId} is not in the conversation's log`);
  await deps.store.clear(request.authors, { user: owner, via: "agent", reason: request.reason });
  const left = taintingAuthors(await deps.store.listTree(conversationId), owner);
  deps.tell(
    conversationId,
    left.length === 0
      ? "The owner cleared this conversation's taint. Within about 10 seconds the sandbox acts as them again (SSH key, commit identity, forge tokens)."
      : `The owner cleared the authors they were shown, but this conversation is still tainted by ${describeTaint(left)}, written since. Call request_untaint again only if the task still needs their credentials.`,
  );
}
