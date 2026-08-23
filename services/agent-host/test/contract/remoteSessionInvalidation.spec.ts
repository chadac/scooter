/**
 * Tier 1 contract — a remote session that DIED (container restart) is re-established, not
 * silently served blank.
 *
 * THE LIVE FAILURE (aeonai, 2026-08-23). The BYO container was recreated; its per-session SDK
 * clients vanished. The cloud bridge still held its CACHED ready session (sdk_<old>) and its
 * already-seeded reinjection marker, so the next prompt went out against a session the new
 * container instance never created. The container's compat fallback served it from the BLANK
 * primary client: no history, no error — the agent "gets confused because it receives no
 * context", and the log proves it (session minted 14:35, container started 14:54, ZERO
 * new_session calls, zero preambles).
 *
 * The contract: when a remote prompt fails with "unknown session", the bridge drops that
 * provider's cached session and retries the run ONCE — the retry re-initializes, creates a
 * session on the CURRENT container instance, and (because the session key is new) the history
 * reinjection fires again. The user sees a normal, context-full turn instead of amnesia.
 */

import { describe, it, expect } from "vitest";

import { createSessionBridge } from "../../src/bridge.js";
import type { AguiEvent } from "../../src/bridge.js";
import { createFakeAcpAgent } from "../fakes/fakeAcpAgent.js";
import { createFakeSandboxApi } from "../fakes/fakeSandboxApi.js";
import { createSandboxExecBackend } from "../../src/exec/sandboxExec.js";
import { acpClientFromTransport } from "../fakes/acpClientFromTransport.js";

const BRIDGE_CONFIG = {
  cwd: "/workspace",
  skillsDir: "/skills",
  agent: { command: "fake", args: [], env: {} },
  sandbox: { name: "s", namespace: "ns" },
};

const priorLog: AguiEvent[] = [
  { type: "TEXT_MESSAGE_START", messageId: "u1", role: "user" } as never,
  { type: "TEXT_MESSAGE_CONTENT", messageId: "u1", delta: "the earlier work" } as never,
  { type: "TEXT_MESSAGE_END", messageId: "u1" } as never,
];

/** A client whose prompt REJECTS "unknown session" until `reviveAfter` clients exist —
 *  modelling the old container's dead session vs the recreated container. */
function makeAgents() {
  const exec = createSandboxExecBackend(createFakeSandboxApi());
  let instances = 0;
  const prompts: Array<Array<{ text?: string }>> = [];
  let newSessions = 0;
  const createClient = () => {
    instances += 1;
    const generation = instances;
    const agent = createFakeAcpAgent();
    agent.setScript([
      { emit: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
      { finish: { stopReason: "end_turn" } },
    ]);
    const client = acpClientFromTransport(agent.transport, exec);
    return new Proxy(client, {
      get(target, prop, recv) {
        if (prop === "newSession") {
          return (p: unknown) => {
            newSessions += 1;
            return (target as never as { newSession: (x: unknown) => unknown }).newSession(p);
          };
        }
        if (prop === "prompt") {
          return (params: { prompt: Array<{ text?: string }> }) => {
            // Generation 1 is the STALE cached session: the (restarted) container does not
            // know it any more.
            if (generation === 1) return Promise.reject(new Error("unknown session sdk_stale (container restarted?)"));
            prompts.push(params.prompt);
            return (target as never as { prompt: (x: unknown) => unknown }).prompt(params);
          };
        }
        return Reflect.get(target, prop, recv);
      },
    });
  };
  return { exec, createClient, prompts, counts: () => ({ instances, newSessions }) };
}

describe("remote session invalidation", () => {
  it("an 'unknown session' prompt failure re-establishes the session AND re-seeds history", async () => {
    const a = makeAgents();
    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG,
      exec: a.exec,
      acpClient: () => Promise.resolve(a.createClient()),
      loadHistory: async () => priorLog,
      deathRetryBaseMs: 5, // the pump's real backoff, shrunk for the test
    });

    const events: AguiEvent[] = [];
    bridge.onEvent((e) => events.push(e));
    await bridge.prompt({ threadId: "t1", text: "continue please" });

    // The retry created a SECOND client + session (the recreated container's world)...
    expect(a.counts().instances).toBe(2);
    expect(a.counts().newSessions).toBe(2);
    // ...its prompt carried the transcript again (new session key -> reinjection re-fires)...
    expect(a.prompts).toHaveLength(1);
    expect(a.prompts[0].some((b) => (b.text ?? "").includes("the earlier work")),
      "the fresh session must be re-seeded — serving it blank is the amnesia bug").toBe(true);
    // ...and the run ENDED well: the pump emits the intermediate RUN_ERROR + RUN_RETRYING for
    // the failed attempt (that is its contract), but the LAST terminal is a normal finish.
    const terminals = events.filter((e) => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR");
    expect(terminals[terminals.length - 1]?.type).toBe("RUN_FINISHED");
  });

  it("a NON-session error retries on the SAME session — no session churn", async () => {
    // The pump's existing backoff handles transient failures; what must NOT happen is the
    // invalidation firing for them — tearing down and re-seeding a healthy session on every
    // model blip would double transcripts and thrash the container.
    const exec = createSandboxExecBackend(createFakeSandboxApi());
    let clients = 0;
    let attempts = 0;
    const factory = () => {
      clients += 1;
      const agent = createFakeAcpAgent();
      const client = acpClientFromTransport(agent.transport, exec);
      return Promise.resolve(new Proxy(client, {
        get(target, prop, recv) {
          if (prop === "prompt") {
            return () => {
              attempts += 1;
              return Promise.reject(new Error("model overloaded"));
            };
          }
          return Reflect.get(target, prop, recv);
        },
      }));
    };
    const bridge = createSessionBridge({
      config: BRIDGE_CONFIG, exec, acpClient: factory, deathRetryBaseMs: 5,
    });
    await bridge.prompt({ threadId: "t1", text: "hi" }).catch(() => undefined);
    expect(attempts).toBeGreaterThan(1); // the pump retried (existing behaviour)
    expect(clients).toBe(1); // but never invalidated the session for a non-session error
  });
});
