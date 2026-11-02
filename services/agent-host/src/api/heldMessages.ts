/** The approval gate holding outsiders' forge comments from the agent. */

import { randomUUID } from "node:crypto";

import type { ApproverIdentity, SessionBridge } from "../bridge.js";
import { logger } from "../log.js";
import type { HeldMessage, HeldMessageStore } from "../session/heldMessageStore.js";

const log = logger("heldMessages");

export interface ScreenRequest {
  source: string;
  author: string;
  /** Repo standing, a linked Scooter account, or the allowlist. */
  standing: boolean;
  /** Linked Scooter users, matched against a private conversation's owner. */
  authorUserIds?: string[];
  url?: string;
  prompt: string;
  text: string;
}

export interface ScreenConversation {
  id: string;
  owner?: string;
  visibility?: string;
}

export type HeldOptionId = "allow_once" | "allow_author" | "deny";

export function heldOptions(author: string): Array<{ optionId: HeldOptionId; name: string; kind: string }> {
  return [
    { optionId: "allow_once", name: "Allow this message", kind: "allow_once" },
    { optionId: "allow_author", name: `Allow @${author} in this conversation`, kind: "allow_always" },
    { optionId: "deny", name: "Deny", kind: "reject_once" },
  ];
}

export interface HeldMessagesDeps {
  store: HeldMessageStore;
  deliver: (conversationId: string, text: string, source: string) => Promise<void>;
  /** The live bridge only; holding a comment never revives. */
  bridge: (conversationId: string) => SessionBridge | undefined;
  /** Log a card for a conversation without a live bridge. */
  persistInterrupt: (conversationId: string, interrupt: HeldInterrupt) => Promise<void>;
  /** Settle a card unanswered, live or logged. */
  withdraw: (conversationId: string, id: string) => Promise<void>;
  /** The durable owner; undefined when unowned. */
  ownerOf: (conversationId: string) => Promise<string | undefined>;
  /** Without AUTH_ENFORCE, anonymous is the single user. */
  authEnforced: boolean;
  now?: () => number;
}

export interface HeldMessages {
  /** Deliver-or-hold; a held comment is stored and carded. */
  screen(conv: ScreenConversation, req: ScreenRequest): Promise<{ held: false } | { held: true; id: string }>;
  /** Re-raise held cards a revive dropped. */
  reRaise(bridge: SessionBridge, conversationId: string): Promise<void>;
}

export function isTrusted(conv: ScreenConversation, req: ScreenRequest, allowed: boolean): boolean {
  if (allowed) return true;
  // Private trusts only the owner and authors they allowed.
  if (conv.visibility === "private") return !!conv.owner && (req.authorUserIds ?? []).includes(conv.owner);
  return req.standing;
}

export function createHeldMessages(deps: HeldMessagesDeps): HeldMessages {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());

  const raise = (bridge: SessionBridge, msg: HeldMessage): void => {
    bridge.raiseInterrupt({
      ...interruptOf(msg),
      onAnswer: (optionId, approver) => {
        void answer(msg, optionId, approver).catch((err) =>
          log.errorWith("held comment answer failed", err, {
            conversation_id: msg.conversationId,
            held_id: msg.id,
            decision: optionId,
          }),
        );
      },
    });
  };

  // Owner only; anonymous answers only in single-user mode.
  const mayAnswer = async (conversationId: string, approver?: ApproverIdentity): Promise<boolean> => {
    if (!approver?.id) return !deps.authEnforced;
    const owner = await deps.ownerOf(conversationId);
    return !owner || owner === approver.id;
  };

  const answer = async (
    msg: HeldMessage,
    optionId: string | null,
    approver?: ApproverIdentity,
  ): Promise<void> => {
    // Dismissed or unknown: stay held until the next revive.
    if (optionId !== "allow_once" && optionId !== "allow_author" && optionId !== "deny") return;
    if (!(await mayAnswer(msg.conversationId, approver))) {
      log.warn("held comment answered by someone who may not", { conversation_id: msg.conversationId, held_id: msg.id });
      return;
    }
    const taken = await store.take(msg.id);
    if (!taken) return; // another replica or viewer already answered it
    const fields = { conversation_id: msg.conversationId, held_id: msg.id, source: msg.source, decision: optionId };
    if (optionId === "deny") {
      log.info("held comment denied", fields);
      return;
    }
    if (optionId === "allow_author") {
      await store.trust(msg.conversationId, msg.source, msg.author, approver?.id ?? "anonymous");
    }
    log.info("held comment allowed", fields);
    await deps.deliver(msg.conversationId, taken.text, taken.source);
    if (optionId !== "allow_author") return;
    // Release the author's other held comments, oldest first.
    const author = msg.author.toLowerCase();
    for (const other of await store.list(msg.conversationId)) {
      if (other.source !== msg.source || other.author.toLowerCase() !== author) continue;
      const next = await store.take(other.id);
      if (!next) continue;
      await deps.withdraw(msg.conversationId, other.id);
      await deps.deliver(msg.conversationId, next.text, next.source);
    }
  };

  return {
    async screen(conv, req) {
      const allowed = await store.isTrusted(conv.id, req.source, req.author);
      if (isTrusted(conv, req, allowed)) return { held: false };
      const msg: HeldMessage = {
        id: randomUUID(),
        conversationId: conv.id,
        source: req.source,
        author: req.author,
        url: req.url ?? "",
        prompt: req.prompt,
        text: req.text,
        createdAt: now(),
      };
      await store.hold(msg);
      log.info("held a comment for approval", { conversation_id: conv.id, held_id: msg.id, source: req.source });
      const bridge = deps.bridge(conv.id);
      // Stay suspended; answering the card revives.
      if (bridge) raise(bridge, msg);
      else await deps.persistInterrupt(conv.id, interruptOf(msg));
      return { held: true, id: msg.id };
    },
    async reRaise(bridge, conversationId) {
      const held = await store.list(conversationId);
      for (const msg of held) raise(bridge, msg);
    },
  };
}

/** A held comment's card, live or logged. */
export interface HeldInterrupt {
  id: string;
  message: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
  metadata: Record<string, unknown>;
}

export function interruptOf(msg: HeldMessage): HeldInterrupt {
  return {
    id: msg.id,
    message: msg.prompt,
    options: heldOptions(msg.author),
    // The kind's prefix picks the card's brand row.
    metadata: { kind: `${msg.source}.held-comment`, data: { author: msg.author, url: msg.url } },
  };
}
