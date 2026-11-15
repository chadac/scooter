import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Asleep, Outbox, overlay, overlayQuestions, POLL_MS, SLOW_POLL_MS, STALL_MS, type Write } from "./outbox";
import type { Annotation, Question } from "./api";

class MemoryStorage {
  data = new Map<string, string>();
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => void this.data.set(k, v);
  removeItem = (k: string) => void this.data.delete(k);
}

/** A sandbox that is asleep until `wake()`, recording each write it takes. */
function sandbox() {
  const state = { up: false, refuse: new Set<string>(), sent: [] as Write[], polls: 0 };
  const send = vi.fn(async (w: Write) => {
    if (!state.up) throw new Asleep("asleep");
    if (w.op === "add" && state.refuse.has(w.body.text)) throw new Error("the anchor no longer matches the file");
    state.sent.push(w);
  });
  const awake = vi.fn(async () => {
    state.polls++;
    return state.up;
  });
  return { state, send, awake };
}

let ids = 0;
const make = (s: ReturnType<typeof sandbox>, storage = new MemoryStorage()) =>
  new Outbox({ send: s.send, awake: s.awake, storage, key: "k", now: Date.now, uuid: () => `id-${++ids}` });

const body = (text: string, extra: object = {}) => ({ path: "doc.md", line: 2, quote: "bravo", text, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  ids = 0;
});
afterEach(() => vi.useRealTimers());

describe("Outbox", () => {
  it("sends straight through while the sandbox is up", async () => {
    const s = sandbox();
    s.state.up = true;
    const box = make(s);
    expect(await box.add(body("hi"))).toBe("sent");
    expect(box.snapshot().entries).toEqual([]);
    expect(s.awake).not.toHaveBeenCalled();
  });

  it("queues an asleep write, wakes the sandbox, then delivers in order", async () => {
    const s = sandbox();
    const box = make(s);
    expect(await box.add(body("first"))).toBe("queued");
    // Later writes queue behind it without trying the server first.
    expect(await box.resolve("t", true)).toBe("queued");
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(box.snapshot().entries.map((e) => e.op)).toEqual(["add", "resolve"]);

    await vi.advanceTimersByTimeAsync(0);
    expect(s.state.polls).toBe(1);
    s.state.up = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(s.state.sent.map((w) => w.op)).toEqual(["add", "resolve"]);
    expect(box.snapshot().entries).toEqual([]);
    expect(box.snapshot().delivered).toBe(2);
    // Nothing left: polling stops.
    const polls = s.state.polls;
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(s.state.polls).toBe(polls);
  });

  it("keeps the client id across replays, so the server can dedupe", async () => {
    const s = sandbox();
    const box = make(s);
    await box.add(body("x"));
    const id = (box.snapshot().entries[0] as { body: { id: string } }).body.id;
    s.state.up = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(s.send.mock.calls.map(([w]) => (w as { body: { id: string } }).body.id)).toEqual([id, id]);
  });

  it("survives a reload through storage", async () => {
    // The closed page never wakes; only the reopened one delivers.
    const closed = sandbox();
    const s = sandbox();
    const storage = new MemoryStorage();
    await make(closed, storage).add(body("kept"));
    const again = make(s, storage);
    expect(again.snapshot().entries).toHaveLength(1);
    s.state.up = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state.sent).toHaveLength(1);
    expect(storage.data.has("k")).toBe(false);
  });

  it("marks a refused comment failed, sends the rest, and retries it on request", async () => {
    const s = sandbox();
    const box = make(s);
    await box.add(body("bad"));
    await box.add(body("good"));
    s.state.refuse.add("bad");
    s.state.up = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(s.state.sent.map((w) => w.op === "add" && w.body.text)).toEqual(["good"]);
    const [left] = box.snapshot().entries;
    expect(left.error).toMatch(/anchor/);

    s.state.refuse.clear();
    const id = (left as { body: { id: string } }).body.id;
    expect(await box.retry(id)).toBe("queued");
    await vi.advanceTimersByTimeAsync(0);
    expect(box.snapshot().entries).toEqual([]);
  });

  it("deleting a queued comment drops it and its queued replies locally", async () => {
    const s = sandbox();
    const box = make(s);
    await box.add(body("opener"));
    const id = (box.snapshot().entries[0] as { body: { id: string } }).body.id;
    await box.add(body("reply", { thread: id }));
    await box.add(body("other"));
    expect(await box.remove(id)).toBe("dropped");
    expect(box.snapshot().entries.map((e) => e.op === "add" && e.body.text)).toEqual(["other"]);
  });

  it("slows down and says so after STALL_MS, and a poke starts over", async () => {
    const s = sandbox();
    const box = make(s);
    await box.add(body("x"));
    await vi.advanceTimersByTimeAsync(STALL_MS - POLL_MS);
    expect(box.snapshot().stalled).toBe(false);
    while (!box.snapshot().stalled) await vi.advanceTimersByTimeAsync(POLL_MS);
    // It flipped on the last poll; the next is SLOW_POLL_MS away.
    const polls = s.state.polls;
    await vi.advanceTimersByTimeAsync(SLOW_POLL_MS - 1);
    expect(s.state.polls).toBe(polls);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state.polls).toBe(polls + 1);

    box.poke();
    expect(box.snapshot().stalled).toBe(false);
    s.state.up = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(box.snapshot().entries).toEqual([]);
  });

  it("keeps polling when the status check itself fails", async () => {
    const s = sandbox();
    s.awake.mockRejectedValueOnce(new TypeError("offline"));
    const box = make(s);
    await box.add(body("x"));
    await vi.advanceTimersByTimeAsync(0);
    s.state.up = true;
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(box.snapshot().entries).toEqual([]);
  });

  it("passes a real server error straight to the caller", async () => {
    const s = sandbox();
    s.state.up = true;
    s.state.refuse.add("bad");
    await expect(make(s).add(body("bad"))).rejects.toThrow(/anchor/);
  });
});

const served = (over: Partial<Annotation>): Annotation => ({
  id: "a",
  path: "doc.md",
  line: 2,
  recorded_line: 2,
  quote: "bravo",
  kind: "comment",
  text: "on the server",
  thread: "a",
  question_id: "",
  by: "reviewer",
  resolved: false,
  created_at: "2026-01-01T00:00:00Z",
  state: "acked",
  error: "",
  anchor_state: "ok",
  ...over,
});

describe("overlay", () => {
  it("shows queued comments, resolves and deletes as already done", async () => {
    const s = sandbox();
    const box = make(s);
    await box.add(body("reply", { thread: "a" }));
    await box.add({ ...body("elsewhere"), path: "other.md" });
    await box.resolve("a", true);
    await box.remove("b");
    const list = [served({}), served({ id: "b", thread: "b" }), served({ id: "c", thread: "b" })];
    const out = overlay(list, box.snapshot().entries, "doc.md");
    expect(out.map((a) => [a.id, a.state, a.resolved])).toEqual([
      ["a", "acked", true],
      ["id-1", "queued", true],
    ]);
    expect(out[1].thread).toBe("a");
  });

  it("drops the optimistic copy once the server holds it", async () => {
    const s = sandbox();
    const box = make(s);
    await box.add(body("x"));
    const out = overlay([served({ id: "id-1", thread: "id-1" })], box.snapshot().entries, "doc.md");
    expect(out.map((a) => a.state)).toEqual(["acked"]);
  });

  it("counts a queued answer on its question", async () => {
    const s = sandbox();
    const box = make(s);
    await box.add(body("Yes", { kind: "answer", question_id: "q1" }));
    const q: Question = { id: "q1", kind: "single", prompt: "?", options: [], line: 9, answers: [], answered: false };
    const [got] = overlayQuestions([q], overlay([], box.snapshot().entries, "doc.md"));
    expect(got.answered).toBe(true);
    expect(got.answers.map((a) => [a.text, a.state])).toEqual([["Yes", "queued"]]);
  });
});
