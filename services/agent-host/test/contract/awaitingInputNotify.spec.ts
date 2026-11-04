/**
 * Pending-question notices: each new interrupt reaches every listening contrib once, with
 * the conversation's links and URL, and a failing broker never throws into the append.
 */

import { describe, it, expect } from "vitest";

import type { AguiEvent } from "../../src/bridge.js";
import {
  createAwaitingInputNotifier,
  parseAwaitingInputNotify,
  type AwaitingInputNotice,
} from "../../src/session/awaitingInputNotify.js";
import type { SessionId } from "../../src/types.js";

const id = "c-1" as SessionId;
const slackLink = { source: "slack", resourceType: "thread", ref: { channel: "C1", threadTs: "1.2" } };

function interrupt(iid: string): AguiEvent {
  return {
    type: "RUN_FINISHED",
    threadId: id,
    runId: "r",
    outcome: {
      type: "interrupt",
      interrupts: [
        {
          id: iid,
          reason: "confirmation",
          message: "The agent has a question",
          metadata: {
            kind: "ask-user.questions",
            data: { questions: [{ question: "Which?", options: [{ label: "A" }] }] },
            options: [{ optionId: "answer", name: "Answer", kind: "allow_once" }],
          },
        },
      ],
    },
  } as AguiEvent;
}

function harness(opts: { status?: number; throws?: boolean; broker?: boolean } = {}) {
  const calls: Array<{ url: string; body: AwaitingInputNotice; headers: unknown }> = [];
  const notify = createAwaitingInputNotifier({
    targets: { slack: { path: "/slack/awaiting-input" } },
    broker: async () => (opts.broker === false ? null : { url: "http://broker", headers: { Authorization: "Bearer t" } }),
    listLinks: async () => [slackLink],
    publicUrl: "https://scooter.example/",
    fetch: (async (url: string, init: RequestInit) => {
      if (opts.throws) throw new Error("connection refused");
      calls.push({ url, body: JSON.parse(init.body as string), headers: init.headers });
      return new Response("", { status: opts.status ?? 200 });
    }) as unknown as typeof fetch,
  });
  if (!notify) throw new Error("expected a notifier");
  return { notify, calls };
}

describe("parseAwaitingInputNotify", () => {
  it("keeps rows with an absolute path and drops the rest", () => {
    expect(parseAwaitingInputNotify('{"slack":{"path":"/slack/awaiting-input"},"bad":{"path":"x"}}')).toEqual({
      slack: { path: "/slack/awaiting-input" },
    });
  });

  it("treats unset or malformed as no targets", () => {
    expect(parseAwaitingInputNotify(undefined)).toEqual({});
    expect(parseAwaitingInputNotify("{nope")).toEqual({});
  });
});

describe("createAwaitingInputNotifier", () => {
  it("is null when no contrib listens", () => {
    expect(createAwaitingInputNotifier({ targets: {}, broker: async () => null, listLinks: async () => [] })).toBeNull();
  });

  it("posts a pending question with its links, url and request", async () => {
    const { notify, calls } = harness();
    await notify(id, interrupt("q1"));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://broker/slack/awaiting-input");
    expect(calls[0].headers).toEqual({ Authorization: "Bearer t" });
    expect(calls[0].body).toEqual({
      conversationId: id,
      conversationUrl: "https://scooter.example/?thread=c-1",
      links: [slackLink],
      interrupt: {
        id: "q1",
        message: "The agent has a question",
        kind: "ask-user.questions",
        data: { questions: [{ question: "Which?", options: [{ label: "A" }] }] },
        options: [{ optionId: "answer", name: "Answer" }],
      },
    });
  });

  it("tells contribs about each interrupt once", async () => {
    const { notify, calls } = harness();
    await notify(id, interrupt("q1"));
    await notify(id, interrupt("q1"));
    await notify(id, interrupt("q2"));
    expect(calls.map((c) => c.body.interrupt.id)).toEqual(["q1", "q2"]);
  });

  it("ignores events that are not interrupts", async () => {
    const { notify, calls } = harness();
    await notify(id, { type: "RUN_FINISHED", threadId: id, runId: "r", outcome: { type: "success" } } as AguiEvent);
    await notify(id, { type: "RUN_STARTED", threadId: id, runId: "r" } as AguiEvent);
    expect(calls).toHaveLength(0);
  });

  it("swallows a refused, failing or absent broker", async () => {
    await expect(harness({ status: 500 }).notify(id, interrupt("q1"))).resolves.toBeUndefined();
    await expect(harness({ throws: true }).notify(id, interrupt("q1"))).resolves.toBeUndefined();
    const none = harness({ broker: false });
    await none.notify(id, interrupt("q1"));
    expect(none.calls).toHaveLength(0);
  });
});

describe("createAwaitingInputNotifier with the webhooks mapping", () => {
  // A Slack-started conversation whose link push failed still has its thread mapped.
  it("adds the mapped thread after the stored links", async () => {
    const bodies: AwaitingInputNotice[] = [];
    const looked: string[] = [];
    const notify = createAwaitingInputNotifier({
      targets: { slack: { path: "/slack/awaiting-input" } },
      broker: async () => ({ url: "http://broker", headers: {} }),
      listLinks: async () => [],
      resourceLookup: {
        lookup: async (_id, source) => {
          looked.push(source);
          return { source, resourceType: "thread", resourceId: "C9:3.4", slackChannel: "C9", slackTs: "3.4" };
        },
      },
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await notify!(id, interrupt("q1"));
    expect(looked).toEqual(["slack"]);
    expect(bodies[0].links).toEqual([
      { source: "slack", resourceType: "thread", url: "C9:3.4", ref: { channel: "C9", threadTs: "3.4" } },
    ]);
  });
});
