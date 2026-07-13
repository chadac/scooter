/**
 * Tier 1 contract — /agui reads the conversation OWNER from the TRUSTED
 * `x-scooter-owner` header ONLY, never the client body (external-user identity
 * mapping). A browser (behind the ingress, which strips the header) can't claim a
 * conversation; the in-cluster webhooks service sets it. See todo/IDENTITY_MAPPING.md.
 */

import { describe, it, expect } from "vitest";

import { createAguiServer, type RunAgentInput } from "../../src/agui/server.js";

/** Stand up the server, capture the onPrompt input, POST one /agui request. */
async function postAgui(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<RunAgentInput | undefined> {
  const server = createAguiServer();
  let captured: RunAgentInput | undefined;
  server.onPrompt(async (_id, input) => {
    captured = input;
  });
  await server.listen(0);
  const ctrl = new AbortController();
  try {
    // /agui streams an SSE response that stays open for the whole run; we only need
    // the prompt to have FIRED, so fire the request (don't await the body) and abort
    // shortly after the onPrompt callback has run.
    void fetch(`http://127.0.0.1:${server.port()}/agui`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).catch(() => {});
    // Poll briefly for the captured prompt (the handler subscribes then calls it).
    for (let i = 0; i < 50 && !captured; i++) await new Promise((r) => setTimeout(r, 10));
  } finally {
    ctrl.abort();
    await server.close();
  }
  return captured;
}

const MSG = { threadId: "t1", messages: [{ role: "user", content: "hi" }] };

describe("/agui owner (trusted header only)", () => {
  it("stamps owner from the x-scooter-owner header", async () => {
    const input = await postAgui(MSG, { "x-scooter-owner": "user-alice" });
    expect(input?.owner).toBe("user-alice");
  });

  it("IGNORES an owner in the client BODY (can't claim via the body)", async () => {
    const input = await postAgui({ ...MSG, owner: "user-attacker" });
    expect(input?.owner).toBeUndefined();
  });

  it("no header -> no owner (the UI path, owner unset here)", async () => {
    const input = await postAgui(MSG);
    expect(input?.owner).toBeUndefined();
  });
});
