/**
 * Tier 1 contract — the HUMAN who answers an approval reaches the handler.
 *
 * An approval interrupt is authorized against the answering person: `onAnswer`
 * relays the approver to the broker, which checks a configured claim (email by
 * default) against its OpenFGA `approver` tuples. So "who answered" is a security
 * input, not telemetry.
 *
 * The bug this pins (PR #649): the UI answers via `POST /agui { resume: [...] }`,
 * and that path carried NO identity — `onResume`'s signature had no approver
 * parameter at all, so `answerPermission` was called without one and the interrupt
 * fell back to `{ id: conversationId }`. The greyed-Approve check (a separate
 * management route) used the real viewer, so the two halves authorized DIFFERENT
 * principals: the UI would tell a user they may approve, then approve as the
 * conversation. With FGA on, no tuple matches that principal and the approval is
 * rejected; with FGA off it succeeds and records the conversation id as the
 * approver, so the audit trail names no human.
 *
 * These assert on the identity the handler RECEIVES, because that is the value
 * that goes on the wire to the broker.
 */

import { describe, it, expect } from "vitest";

import { createAguiServer } from "../../src/agui/server.js";
import type { ApproverIdentity } from "../../src/bridge.js";

/** Run one resume through the real HTTP path, returning what onResume was handed. */
async function resumeWith(
  headers: Record<string, string>,
  resolveUser?: (req: { headers: Record<string, string | string[] | undefined> }) => {
    id: string;
    email?: string;
    name?: string;
    anonymous: boolean;
  },
  entries = [{ interruptId: "req-1", status: "resolved" as const, payload: { optionId: "approve" } }],
): Promise<Array<ApproverIdentity | undefined>> {
  const server = createAguiServer();
  const seen: Array<ApproverIdentity | undefined> = [];
  server.onResume(async (_sessionId, _entry, approver) => {
    seen.push(approver);
    return { ok: true };
  });
  if (resolveUser) server.useIdentityResolver(resolveUser as never);
  await server.listen(0);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`http://127.0.0.1:${server.port()}/agui`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ threadId: "t1", resume: entries }),
      signal: ctrl.signal,
    });
    await res.text();
  } catch {
    /* the stream stays open on ok:true; we only need the handler's argument */
  } finally {
    clearTimeout(timer);
    await server.close();
  }
  return seen;
}

/** A header-auth ingress: the common case (x-auth-user / x-auth-email). */
const headerResolver = (req: { headers: Record<string, string | string[] | undefined> }) => {
  const id = req.headers["x-auth-user"] as string | undefined;
  return id
    ? { id, email: req.headers["x-auth-email"] as string | undefined, anonymous: false }
    : { id: "anonymous", anonymous: true };
};

describe("/agui resume — the approver identity", () => {
  it("hands onResume the human who answered", async () => {
    const seen = await resumeWith(
      { "x-auth-user": "alice", "x-auth-email": "alice@example.com" },
      headerResolver,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ id: "alice", email: "alice@example.com", name: undefined });
  });

  it("carries the EMAIL claim, not just the id", async () => {
    // The broker's default approver_claim is `email`; an identity narrowed to {id}
    // resolves to the id and never matches an email-seeded approver tuple.
    const [approver] = await resumeWith(
      { "x-auth-user": "sub-abc123", "x-auth-email": "alice@example.com" },
      headerResolver,
    );
    expect(approver?.email).toBe("alice@example.com");
  });

  it("leaves the approver undefined when the caller is anonymous", async () => {
    // Not a synthetic principal: a deployment with no ingress identity keeps its
    // existing behavior rather than authorizing something that isn't a person.
    const [approver] = await resumeWith({}, headerResolver);
    expect(approver).toBeUndefined();
  });

  it("is undefined when no resolver is wired at all (local/dev)", async () => {
    const [approver] = await resumeWith({ "x-auth-user": "alice" });
    expect(approver).toBeUndefined();
  });

  it("gives every entry in a batched resume the same answerer", async () => {
    // One HTTP request == one human, so the identity is resolved once for the batch.
    const seen = await resumeWith({ "x-auth-user": "alice" }, headerResolver, [
      { interruptId: "req-1", status: "resolved" as const, payload: { optionId: "approve" } },
      { interruptId: "req-2", status: "resolved" as const, payload: { optionId: "deny" } },
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ id: "alice", email: undefined, name: undefined });
    expect(seen[1]).toEqual(seen[0]);
  });

  it("still answers when the identity resolver throws", async () => {
    // A broken resolver must not block a security decision the user already made;
    // it degrades to anonymous (the broker then applies its own fallback).
    const seen = await resumeWith({}, (() => {
      throw new Error("identity backend down");
    }) as never);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeUndefined();
  });
});
