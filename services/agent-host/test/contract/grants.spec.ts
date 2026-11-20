/**
 * The grants relay: lists every contrib's grants for the Approvals tab, relays a verb
 * with the viewer's identity, tells the agent when its access changed, and ends a
 * deleted conversation's grants.
 */

import { describe, it, expect, vi } from "vitest";

import { createGrantsRelay } from "../../src/grants.js";

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function broker(answer: (url: string, body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body, headers: Object.fromEntries(new Headers(init.headers)) });
    const { status = 200, json } = answer(url, body);
    return new Response(JSON.stringify(json), { status });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const contribs = {
  k8s: { brokerPrefix: "/k8s/approvals", grantsPrefix: "/k8s/grants" },
  aws: { brokerPrefix: "/aws/aws", grantsPrefix: "/aws/grants/" },
  handoff: { brokerPrefix: "/handoff/approvals" },
};
const alice = { id: "u-alice", email: "alice@x", assertion: "signed" };
const grant = (id: string) => ({ id, title: id, scope: [], status: "active", granted_by: "a", granted_at: 1, expires_at: null, verbs: [] });

function relay(answer: Parameters<typeof broker>[0]) {
  const b = broker(answer);
  const notify = vi.fn();
  const warn = vi.fn();
  const r = createGrantsRelay({
    contribs,
    // The real auth headers carry Content-Type; never send it twice.
    brokerAuth: async () => ({ url: "http://broker", headers: { authorization: "Bearer sa", "Content-Type": "application/json" } }),
    notify,
    warn,
    fetch: b.fetch,
  });
  return { r, notify, warn, calls: b.calls };
}

describe("grants relay", () => {
  it("lists every contrib with grants, tags each grant and skips one that fails", async () => {
    const { r, calls, warn } = relay((url) =>
      url.startsWith("http://broker/k8s") ? { json: { grants: [grant("g1")] } } : { status: 500, json: {} },
    );
    const out = await r.list(["key", "conv"], alice);
    expect(out).toEqual([{ ...grant("g1"), contrib: "k8s" }]);
    expect(calls.map((c) => c.url).sort()).toEqual(["http://broker/aws/grants/list", "http://broker/k8s/grants/list"]);
    // The assertion travels as a header, never in the body.
    expect(calls[0].body).toEqual({ approver: { id: "u-alice", email: "alice@x" }, conversation_ids: ["key", "conv"] });
    expect(calls[0].headers).toMatchObject({ authorization: "Bearer sa", "content-type": "application/json" });
    expect(warn).toHaveBeenCalledWith("grants list returned a non-2xx", { contrib: "aws", status: 500 });
  });

  it("relays a verb with minutes and tells the agent", async () => {
    const { r, calls, notify } = relay(() => ({ json: { grant: grant("g1"), agent_message: "extended" } }));
    const out = await r.act("conv", ["key"], "k8s", "g1", "extend", alice, 60);
    expect(out.status).toBe(200);
    expect(calls[0].url).toBe("http://broker/k8s/grants/g1/extend");
    expect(calls[0].body).toMatchObject({ conversation_ids: ["key"], minutes: 60 });
    expect(notify).toHaveBeenCalledWith("conv", "extended");
  });

  it("passes a refusal through with the broker's reason and tells the agent nothing", async () => {
    const { r, notify } = relay(() => ({ status: 403, json: { detail: { errors: ["u-alice may not revoke this grant"] } } }));
    expect(await r.act("conv", ["key"], "aws", "g1", "revoke", alice)).toEqual({
      status: 403,
      json: { error: "u-alice may not revoke this grant" },
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("404s a contrib that keeps no grants", async () => {
    const { r, calls } = relay(() => ({ json: {} }));
    expect((await r.act("conv", ["key"], "handoff", "g1", "revoke", alice)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("revokes a deleted conversation's grants under each key", async () => {
    const { r, calls } = relay(() => ({ json: { revoked: 1 } }));
    await r.revokeConversation(["key", "conv"]);
    expect(calls.map((c) => [c.url, c.body.conversation_id]).sort()).toEqual([
      ["http://broker/aws/grants/revoke-conversation", "conv"],
      ["http://broker/aws/grants/revoke-conversation", "key"],
      ["http://broker/k8s/grants/revoke-conversation", "conv"],
      ["http://broker/k8s/grants/revoke-conversation", "key"],
    ]);
  });
});
