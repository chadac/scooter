/**
 * Tier 1 contract — /agui honors the conversation OWNER only for the TRUSTED
 * webhooks caller (verified by its SA token via TokenReview — useOwnerVerifier).
 * A browser / any other caller can't claim a conversation.
 */

import { describe, it, expect } from "vitest";

import { createAguiServer, type RunAgentInput } from "../../src/agui/server.js";

/** Stand up the server (optional owner-verifier + identity resolver), capture the
 *  onPrompt input (whose `owner` is the RESOLVED owner the handler computed), POST
 *  once. `identity` = the ingress user the resolver returns for the caller. */
async function postAgui(
  body: Record<string, unknown>,
  trusted: boolean | undefined,
  identity?: { id: string; anonymous: boolean },
): Promise<RunAgentInput | undefined> {
  const server = createAguiServer();
  let captured: RunAgentInput | undefined;
  server.onPrompt(async (_id, input) => {
    captured = input;
  });
  if (trusted !== undefined) server.useOwnerVerifier(async () => trusted);
  if (identity) server.useIdentityResolver(async () => identity);
  await server.listen(0);
  const ctrl = new AbortController();
  try {
    void fetch(`http://127.0.0.1:${server.port()}/agui`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).catch(() => {});
    for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 10));
  } finally {
    ctrl.abort();
    await server.close();
  }
  return captured;
}

const MSG = { threadId: "t1", messages: [{ role: "user", content: "hi" }], owner: "user-alice" };

describe("/agui owner (trusted-caller gated)", () => {
  it("honors owner when the caller is the trusted webhooks SA (verifier true)", async () => {
    const input = await postAgui(MSG, true);
    expect(input?.owner).toBe("user-alice");
  });

  it("IGNORES owner when the caller is NOT trusted (verifier false)", async () => {
    const input = await postAgui(MSG, false);
    expect(input?.owner).toBeUndefined();
  });

  it("IGNORES owner when NO verifier is wired (safe default)", async () => {
    const input = await postAgui(MSG, undefined);
    expect(input?.owner).toBeUndefined();
  });

  it("no owner in the body -> no owner even when trusted", async () => {
    const input = await postAgui({ threadId: "t1", messages: [{ role: "user", content: "hi" }] }, true);
    expect(input?.owner).toBeUndefined();
  });
});

// The bug: a browser doesn't send `owner`; the server must resolve the caller's
// INGRESS IDENTITY and own the conversation to them (like /whoami). Without this a
// UI-created conversation had no owner and never showed under the Mine filter.
describe("/agui owner (resolved from ingress identity — the UI path)", () => {
  const UI_MSG = { threadId: "t1", messages: [{ role: "user", content: "hi" }] };

  it("stamps the RESOLVED user id as owner when the caller is identified (non-anonymous)", async () => {
    const input = await postAgui(UI_MSG, undefined, { id: "user-alice", anonymous: false });
    expect(input?.owner).toBe("user-alice");
  });

  it("does NOT stamp an owner for an ANONYMOUS caller (single-user / FGA-off)", async () => {
    const input = await postAgui(UI_MSG, undefined, { id: "anonymous", anonymous: true });
    expect(input?.owner).toBeUndefined();
  });

  it("the PRIVILEGED webhooks owner wins over the resolved identity", async () => {
    // A trusted webhooks call with an explicit owner claims for THAT user, even
    // though the caller's own ingress identity resolves to someone else.
    const input = await postAgui(
      { ...UI_MSG, owner: "user-claimed" },
      /* trusted */ true,
      { id: "webhooks-sa", anonymous: false },
    );
    expect(input?.owner).toBe("user-claimed");
  });

  it("falls back to the resolved identity when a webhooks owner is present but the caller is NOT trusted", async () => {
    const input = await postAgui(
      { ...UI_MSG, owner: "user-spoofed" },
      /* trusted */ false,
      { id: "user-real", anonymous: false },
    );
    expect(input?.owner).toBe("user-real"); // the spoofed body owner is ignored
  });
});
