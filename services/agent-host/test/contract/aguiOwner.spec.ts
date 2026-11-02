/**
 * /agui honors a body `owner` only for the trusted webhooks caller (verified via
 * useOwnerVerifier); any other caller's conversation is owned by its resolved ingress
 * identity, and an anonymous caller gets no owner.
 */

import { describe, it, expect } from "vitest";

import { createAguiServer, parseInboundSender, type RunAgentInput } from "../../src/agui/server.js";

/** POST once to a server with an optional owner verifier and identity resolver, returning the onPrompt input. */
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

// A browser sends no `owner`, so the server resolves the caller's ingress identity and owns the conversation to them.
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
    // A trusted webhooks call with an explicit owner claims for that user, whatever its own ingress identity.
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
    expect(input?.owner).toBe("user-real");
  });
});

describe("/agui sender (trusted-caller gated, like owner)", () => {
  const SENDER = { provider: "github", externalId: "29139614", handle: "renovate[bot]", level: 40 };
  const BODY = { threadId: "t1", messages: [{ role: "user", content: "hi" }], source: "github", sender: SENDER };

  it("passes a well-formed sender from the trusted webhooks caller", async () => {
    const input = await postAgui(BODY, true);
    expect(input?.sender).toEqual(SENDER);
  });

  it("drops the sender from an untrusted caller, and from a server with no verifier", async () => {
    expect((await postAgui(BODY, false))?.sender).toBeUndefined();
    expect((await postAgui(BODY, undefined))?.sender).toBeUndefined();
  });

  it("a sender alone (no owner) still gets verified", async () => {
    const input = await postAgui(BODY, true, { id: "webhooks-sa", anonymous: false });
    expect(input?.sender?.externalId).toBe("29139614");
    expect(input?.owner).toBe("webhooks-sa");
  });
});

describe("parseInboundSender", () => {
  const ok = { provider: "gitlab", externalId: "42", handle: "alice", level: 60 };

  it("accepts the contrib levels and keeps a display name", () => {
    for (const level of [40, 60, 80, 100]) expect(parseInboundSender({ ...ok, level })?.level).toBe(level);
    expect(parseInboundSender({ ...ok, displayName: "Alice" })?.displayName).toBe("Alice");
  });

  it("refuses self and vouched, which only the agent-host can assign", () => {
    expect(parseInboundSender({ ...ok, level: 0 })).toBeUndefined();
    expect(parseInboundSender({ ...ok, level: 20 })).toBeUndefined();
  });

  it("refuses an unknown provider, a scooter identity, and a missing stable id", () => {
    expect(parseInboundSender({ ...ok, provider: "scooter" })).toBeUndefined();
    expect(parseInboundSender({ ...ok, provider: "myspace" })).toBeUndefined();
    expect(parseInboundSender({ ...ok, externalId: "" })).toBeUndefined();
    expect(parseInboundSender({ ...ok, externalId: 42 })).toBeUndefined();
    expect(parseInboundSender("github:alice")).toBeUndefined();
  });

  it("refuses an off-scale level", () => {
    expect(parseInboundSender({ ...ok, level: 50 })).toBeUndefined();
    expect(parseInboundSender({ ...ok, level: "40" })).toBeUndefined();
  });
});
