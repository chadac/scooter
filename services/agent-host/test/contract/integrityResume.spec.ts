/**
 * GET /conversations/:id/events.integrity?afterSeq=&checksum= resumes a client's cached
 * fold: a cursor matching the log gets only the events after it, anything else gets a
 * `reset` frame followed by the usual snapshot replay. `synced` reports the cursor to keep.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createFileConversationStore } from "../../src/session/fileStore.js";
import { chainsFrom, createManagementApi, resumeCursor, RESUME_MAX_EVENTS } from "../../src/api/management.js";
import type { ChecksummedEvent, ConversationStore, SessionManager } from "../../src/session/manager.js";
import type { AguiEvent } from "../../src/bridge.js";

const ID = "conv-r";

const turn = (n: number): AguiEvent[] =>
  [
    { type: "RUN_STARTED", threadId: "t", runId: `r${n}` },
    { type: "TEXT_MESSAGE_START", messageId: `m${n}`, role: "assistant" },
    { type: "TEXT_MESSAGE_CONTENT", messageId: `m${n}`, delta: `reply ${n}` },
    { type: "TEXT_MESSAGE_END", messageId: `m${n}` },
    { type: "RUN_FINISHED", threadId: "t", runId: `r${n}` },
  ] as unknown as AguiEvent[];

interface Frame {
  kind: string;
  seq?: number;
  checksum?: string;
  event?: { type: string; delta?: string };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function setup(turns: number): Promise<{ store: ConversationStore; log: ChecksummedEvent[] }> {
  const root = mkdtempSync(join(tmpdir(), "integrity-resume-"));
  roots.push(root);
  const store = createFileConversationStore(root);
  for (let n = 1; n <= turns; n++) for (const e of turn(n)) await store.appendEvent(ID, e);
  const log: ChecksummedEvent[] = [];
  for await (const c of store.readEventsWithChecksum!(ID)) log.push(c);
  return { store, log };
}

/** Open the stream with `query`, let replay finish, and return its parsed frames. */
async function frames(store: ConversationStore, query = ""): Promise<Frame[]> {
  const api = createManagementApi({
    sessions: {
      get: (x: string) => (x === ID ? ({ id: ID } as never) : undefined),
      ensureReadable: async (x: string) => x === ID,
    } as unknown as SessionManager,
    store,
    server: { broadcast: () => {} } as never,
    answerInterrupt: async () => ({ ok: true }),
  });
  const req = new PassThrough() as unknown as IncomingMessage;
  (req as { method?: string }).method = "GET";
  (req as { url?: string }).url = `/conversations/${ID}/events.integrity${query}`;
  (req as { headers?: Record<string, string> }).headers = {};
  let body = "";
  const res = {
    writeHead: () => res,
    write: (c: string) => ((body += c), true),
    end: () => {},
    on: () => res,
    req,
  } as unknown as ServerResponse;
  const done = api.handle(req, res);
  await new Promise((r) => setTimeout(r, 50));
  (req as PassThrough).emit("close");
  await done;
  return body
    .split("\n\n")
    .filter((f) => f.startsWith("data: "))
    .map((f) => JSON.parse(f.slice(6)) as Frame)
    .filter((f) => f.kind !== "topic");
}

const cursor = (c: ChecksummedEvent) => `?afterSeq=${c.seq}&checksum=${c.checksum}`;

describe("events.integrity — resume cursor", () => {
  it("reports the head cursor on synced for a plain replay", async () => {
    const { store, log } = await setup(2);
    const synced = (await frames(store)).find((f) => f.kind === "synced");
    expect(synced).toMatchObject({ seq: log.length, checksum: log[log.length - 1].checksum });
  });

  it("sends only the events after a matching cursor", async () => {
    const { store, log } = await setup(3);
    const out = await frames(store, cursor(log[4]));

    expect(out[0]).toEqual({ kind: "resume" });
    const events = out.filter((f) => f.kind === "event");
    expect(events.map((f) => f.seq)).toEqual(log.slice(5).map((c) => c.seq));
    expect(events.some((f) => f.event?.type === "MESSAGES_SNAPSHOT")).toBe(false);
    expect(out.at(-1)).toMatchObject({ kind: "synced", seq: log.length, checksum: log.at(-1)!.checksum });
  });

  it("resumes with nothing to send when the client is already at the head", async () => {
    const { store, log } = await setup(1);
    const out = await frames(store, cursor(log.at(-1)!));
    expect(out.map((f) => f.kind)).toEqual(["resume", "synced"]);
    expect(out[1]).toMatchObject({ seq: log.length });
  });

  it("resets on a checksum that does not match the log", async () => {
    const { store, log } = await setup(2);
    const out = await frames(store, `?afterSeq=${log[4].seq}&checksum=${"f".repeat(64)}`);

    expect(out[0]).toEqual({ kind: "reset" });
    expect(out.some((f) => f.event?.type === "MESSAGES_SNAPSHOT")).toBe(true);
  });

  it("resets on a cursor past the end of the log", async () => {
    const { store, log } = await setup(1);
    const out = await frames(store, `?afterSeq=${log.length + 5}&checksum=${log.at(-1)!.checksum}`);
    expect(out[0]).toEqual({ kind: "reset" });
  });

  it("resets when more than RESUME_MAX_EVENTS follow the cursor", async () => {
    const turns = Math.ceil((RESUME_MAX_EVENTS + 10) / 5);
    const { store, log } = await setup(turns);
    const out = await frames(store, cursor(log[0]));
    expect(out[0]).toEqual({ kind: "reset" });
  });

  it("resets rather than send a slice with a gap in it", async () => {
    const { store, log } = await setup(2);
    // A store whose slice drops one event after the anchor.
    const gappy: ConversationStore = {
      ...store,
      readEventsWithChecksum: (id) => store.readEventsWithChecksum!(id),
      readEventsAfter: async (id, afterSeq, limit) => {
        const r = await store.readEventsAfter!(id, afterSeq, limit);
        return { ...r, events: r.events.filter((_, i) => i !== 1) };
      },
    };
    const out = await frames(gappy, cursor(log[2]));
    expect(out[0]).toEqual({ kind: "reset" });
    expect(out.some((f) => f.event?.type === "MESSAGES_SNAPSHOT")).toBe(true);
  });

  it("sends no reset frame when no cursor was offered", async () => {
    const { store } = await setup(1);
    expect((await frames(store)).some((f) => f.kind === "reset" || f.kind === "resume")).toBe(false);
  });
});

describe("chainsFrom", () => {
  it("accepts a contiguous chain and rejects a skipped or forked one", async () => {
    const { log } = await setup(1);
    const anchor = { seq: log[0].seq!, checksum: log[0].checksum };
    expect(chainsFrom(anchor, log.slice(1))).toBe(true);
    expect(chainsFrom(anchor, [])).toBe(true);
    expect(chainsFrom(anchor, log.slice(2))).toBe(false);
    expect(chainsFrom({ ...anchor, checksum: "f".repeat(64) }, log.slice(1))).toBe(false);
  });
});

describe("resumeCursor", () => {
  const sum = "a".repeat(64);
  it.each([
    ["", undefined],
    [`afterSeq=3&checksum=${sum}`, { afterSeq: 3, checksum: sum }],
    [`afterSeq=0&checksum=${sum}`, undefined],
    [`afterSeq=1.5&checksum=${sum}`, undefined],
    ["afterSeq=3&checksum=nothex", undefined],
    [`checksum=${sum}`, undefined],
  ])("parses %j", (q, want) => {
    expect(resumeCursor(new URLSearchParams(q))).toEqual(want);
  });
});
