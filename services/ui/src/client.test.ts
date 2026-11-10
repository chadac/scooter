/** loadHistory folds a MESSAGE_IMAGES ref onto its user message so an image survives a refresh. */

import { describe, it, expect, vi, afterEach } from "vitest";

import { createSession, loadHistory } from "./client.js";

function mockHistory(events: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ events }) })) as never,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("loadHistory (multimodal replay)", () => {
  it("folds MESSAGE_IMAGES onto the user message it follows", async () => {
    mockHistory([
      { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "what is this?" },
      { type: "TEXT_MESSAGE_END", messageId: "u1" },
      {
        type: "MESSAGE_IMAGES",
        messageId: "u1",
        images: [{ assetId: "a.png", mimeType: "image/png", url: "/conversations/c1/assets/a.png" }],
      },
    ]);
    const msgs = await loadHistory({ baseUrl: "" }, "c1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ id: "u1", role: "user", content: "what is this?" });
    expect(msgs[0].images).toEqual([
      { assetId: "a.png", mimeType: "image/png", url: "/conversations/c1/assets/a.png" },
    ]);
  });

  it("keeps an IMAGE-ONLY message (empty text) instead of dropping it", async () => {
    mockHistory([
      { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" },
      { type: "TEXT_MESSAGE_END", messageId: "u1" },
      { type: "MESSAGE_IMAGES", messageId: "u1", images: [{ assetId: "a.png", mimeType: "image/png", url: "/c/a.png" }] },
    ]);
    const msgs = await loadHistory({ baseUrl: "" }, "c1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].images).toHaveLength(1);
  });

  it("a text-only conversation folds exactly as before (no images field needed)", async () => {
    mockHistory([
      { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "hello" },
      { type: "TEXT_MESSAGE_END", messageId: "u1" },
    ]);
    const msgs = await loadHistory({ baseUrl: "" }, "c1");
    expect(msgs).toEqual([{ id: "u1", role: "user", content: "hello" }]);
  });
});

describe("createSession", () => {
  const bodies = () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, json: async () => ({ id: "s1" }) }));
    vi.stubGlobal("fetch", f as never);
    return () => f.mock.calls.map(([, init]) => JSON.parse(String(init.body)) as unknown);
  };

  it("sends no seed for a blank start and the mode for a summary one", async () => {
    const sent = bodies();
    expect(await createSession({ baseUrl: "" }, "p1")).toEqual({ id: "s1" });
    expect(await createSession({ baseUrl: "" }, "p1", "summary")).toEqual({ id: "s1" });
    expect(sent()).toEqual([{ origin: "web" }, { origin: "web", seed: { mode: "summary" } }]);
  });
});
