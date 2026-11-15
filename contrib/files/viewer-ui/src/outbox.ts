// Writes held in localStorage while the sandbox sleeps.

import type { Annotation, Question } from "./api";

/** The sandbox is down, or nothing answered at all. */
export class Asleep extends Error {}

export type AddBody = {
  path: string;
  line: number;
  quote?: string;
  text: string;
  thread?: string;
  kind?: "comment" | "answer";
  question_id?: string;
};

export type Write =
  | { op: "add"; body: AddBody & { id: string } }
  | { op: "resolve"; thread: string; resolved: boolean }
  | { op: "remove"; target: string }
  | { op: "retry"; target: string };

/** A write waiting in the outbox; `error` set means the server refused it. */
export type Queued = Write & { key: string; at: string; error?: string };

export type Snapshot = {
  entries: readonly Queued[];
  /** Not awake after STALL_MS; polling slows down. */
  stalled: boolean;
  /** Bumped per delivered write, so the page refetches. */
  delivered: number;
};

export const POLL_MS = 1500;
export const SLOW_POLL_MS = 15_000;
export const STALL_MS = 3 * 60_000;

type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

export type Deps = {
  /** Performs one write; throws Asleep while the sandbox is down. */
  send: (w: Write) => Promise<unknown>;
  /** Wakes the sandbox if needed; true once the viewer can take writes. */
  awake: () => Promise<boolean>;
  storage: Storage | null;
  key: string;
  now?: () => number;
  uuid?: () => string;
};

export function uuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  // randomUUID needs a secure context; plain http still has getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export class Outbox {
  private entries: Queued[];
  private stalled = false;
  private delivered = 0;
  private since = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private snap: Snapshot;
  private listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? uuid;
    this.entries = this.load();
    this.snap = this.freeze();
    if (this.waiting().length) this.start();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  snapshot = () => this.snap;

  add(body: AddBody & { id?: string }) {
    return this.submit({ op: "add", body: { ...body, id: body.id ?? this.uuid() } });
  }

  resolve(thread: string, resolved: boolean) {
    return this.submit({ op: "resolve", thread, resolved });
  }

  /** A queued comment is dropped locally, with its queued replies. */
  remove(target: string) {
    const mine = this.entries.filter((e) => e.op === "add" && (e.body.id === target || e.body.thread === target));
    if (mine.some((e) => e.op === "add" && e.body.id === target)) {
      this.entries = this.entries.filter((e) => !mine.includes(e));
      this.changed();
      return Promise.resolve("dropped" as const);
    }
    return this.submit({ op: "remove", target });
  }

  /** Requeue a refused outbox comment, else ask the server. */
  retry(target: string) {
    const e = this.entries.find((e) => e.op === "add" && e.body.id === target && e.error);
    if (e) {
      this.entries = this.entries.map((x) => (x === e ? { ...x, error: undefined } : x));
      this.start();
      this.changed();
      return Promise.resolve("queued" as const);
    }
    return this.submit({ op: "retry", target });
  }

  /** Check right away, and start the stall clock over. */
  poke() {
    if (!this.waiting().length) return;
    this.since = this.now();
    this.stalled = false;
    this.changed();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule(0);
  }

  async submit(w: Write): Promise<"sent" | "queued"> {
    // Queue behind earlier writes to keep their order.
    if (!this.waiting().length) {
      try {
        await this.deps.send(w);
        return "sent";
      } catch (err) {
        if (!(err instanceof Asleep)) throw err;
      }
    }
    this.entries = [...this.entries, { ...w, key: this.uuid(), at: new Date(this.now()).toISOString() }];
    this.start();
    this.changed();
    return "queued";
  }

  private waiting() {
    return this.entries.filter((e) => !e.error);
  }

  private start() {
    if (!this.timer) {
      this.since = this.now();
      this.stalled = false;
    }
    this.schedule(0);
  }

  private schedule(ms: number) {
    if (this.timer || !this.waiting().length) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick() {
    const up = await this.deps.awake().catch(() => false);
    if (up) await this.flush();
    this.timer = undefined;
    if (!this.waiting().length) {
      if (this.stalled) {
        this.stalled = false;
        this.changed();
      }
      return;
    }
    const stalled = this.now() - this.since >= STALL_MS;
    if (stalled !== this.stalled) {
      this.stalled = stalled;
      this.changed();
    }
    this.schedule(stalled ? SLOW_POLL_MS : POLL_MS);
  }

  private async flush() {
    for (const e of this.waiting()) {
      try {
        await this.deps.send(e);
      } catch (err) {
        if (err instanceof Asleep) return;
        // Keep a refused comment so its text survives.
        const message = err instanceof Error ? err.message : String(err);
        this.entries =
          e.op === "add"
            ? this.entries.map((x) => (x.key === e.key ? { ...x, error: message } : x))
            : this.entries.filter((x) => x.key !== e.key);
        this.changed();
        continue;
      }
      this.entries = this.entries.filter((x) => x.key !== e.key);
      this.delivered++;
      this.changed();
    }
  }

  private load(): Queued[] {
    try {
      const raw = this.deps.storage?.getItem(this.deps.key);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private freeze(): Snapshot {
    return { entries: this.entries, stalled: this.stalled, delivered: this.delivered };
  }

  private changed() {
    try {
      if (this.entries.length) this.deps.storage?.setItem(this.deps.key, JSON.stringify(this.entries));
      else this.deps.storage?.removeItem(this.deps.key);
    } catch {
      // Storage full or blocked: keep the queue in memory.
    }
    this.snap = this.freeze();
    for (const fn of this.listeners) fn();
  }
}

function optimistic(e: Queued & { op: "add" }): Annotation {
  const b = e.body;
  return {
    id: b.id,
    path: b.path,
    line: b.line,
    recorded_line: b.line,
    quote: b.quote ?? "",
    kind: b.kind ?? "comment",
    text: b.text,
    thread: b.thread || b.id,
    question_id: b.question_id ?? "",
    by: "reviewer",
    resolved: false,
    created_at: e.at,
    state: e.error ? "failed" : "queued",
    error: e.error ?? "",
    anchor_state: "ok",
  };
}

/** One file's annotations as they'll be once the outbox is sent. */
export function overlay(list: Annotation[], entries: readonly Queued[], path: string): Annotation[] {
  let out = list;
  for (const e of entries) {
    if (e.op === "add") {
      if (e.body.path === path && !out.some((a) => a.id === e.body.id)) out = [...out, optimistic(e)];
    } else if (e.error) {
      continue;
    } else if (e.op === "resolve") {
      out = out.map((a) => (a.thread === e.thread ? { ...a, resolved: e.resolved } : a));
    } else if (e.op === "remove") {
      // Thread id is the opener id: replies go too.
      out = out.filter((a) => a.id !== e.target && a.thread !== e.target);
    } else {
      out = out.map((a) => (a.id === e.target ? { ...a, state: "queued", error: "" } : a));
    }
  }
  return out;
}

/** Questions with their queued answers counted. */
export function overlayQuestions(questions: Question[], annotations: Annotation[]): Question[] {
  const queued = annotations.filter((a) => a.kind === "answer" && (a.state === "queued" || a.state === "failed"));
  if (!queued.length) return questions;
  return questions.map((q) => {
    const mine = queued.filter((a) => a.question_id === q.id && !q.answers.some((x) => x.id === a.id));
    return mine.length ? { ...q, answers: [...q.answers, ...mine], answered: true } : q;
  });
}
