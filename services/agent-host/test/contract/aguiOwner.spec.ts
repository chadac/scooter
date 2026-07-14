/**
 * Tier 1 contract — /agui honors the conversation OWNER only for the TRUSTED
 * webhooks caller (verified by its SA token via TokenReview — useOwnerVerifier).
 * A browser / any other caller can't claim a conversation. See todo/IDENTITY_MAPPING.md.
 */

import { describe, it, expect } from "vitest";

import { createAguiServer, type RunAgentInput } from "../../src/agui/server.js";

/** Stand up the server (with a given owner-verifier), capture onPrompt, POST once. */
async function postAgui(
  body: Record<string, unknown>,
  trusted: boolean | undefined,
): Promise<RunAgentInput | undefined> {
  const server = createAguiServer();
  let captured: RunAgentInput | undefined;
  server.onPrompt(async (_id, input) => {
    captured = input;
  });
  if (trusted !== undefined) server.useOwnerVerifier(async () => trusted);
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
