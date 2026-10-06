/**
 * Tier 2 — the conversation event log's two durability invariants, on a real cluster.
 *
 * Both halves of PR #723 were found in a `flake focus full` log and fixed with contract tests
 * against a fake db. Those tests pin the LOGIC; they cannot reach the seam the bugs actually
 * lived in — a real `conversation_events` table with a real primary key, a real `conversations`
 * row carrying the append fence, and more than one agent-host replica able to write.
 *
 * Why this exists rather than another `e2e-full-flake-check` run: two of those runs
 * (37488942901, 37494029989) showed the limit of waiting for a race. The first produced ONE
 * hand-off in nine minutes and so could not fire at all; the second produced ten and caught
 * four real collisions, but only because the cluster happened to oblige, and the targeted test
 * title carried an unrelated flake of its own. A flake check bounds how often a bug can still
 * fire. It never proves the mechanism works. These two tests FORCE each condition instead.
 *
 *   1. DELETE drops the event rows.
 *      `eventStore.removeConversation` existed from the day the log moved to Postgres and
 *      index.ts never called it, so every conversation ever deleted kept its complete log.
 *      Invisible to the API — a deleted conversation reads as gone while its rows remain —
 *      which is why this asserts against Postgres directly.
 *
 *   2. A seq collision does not lose the turn.
 *      The append fence refuses only on a CONTRADICTION, so an unclaimed `conversations` row
 *      admits two writers by design (a new conversation streams its first turn before anything
 *      claims it). Both derive the same seq, the PK catches the loser, and the loser used to
 *      discard the event — one lost turn per collision, which is #678's signature. Here the
 *      rival writer is impersonated with a direct INSERT at the seq the owning pod is about to
 *      use, so the collision is deterministic rather than hoped for.
 *
 * Gated on RUN_CLUSTER_TESTS=1; runs against the deployed platform in `agent-sandbox`.
 */

import { describe, it, expect, beforeAll } from "vitest";

import { withCluster, clusterTestsEnabled, type Cluster } from "../support/cluster.js";
import { kubectl, psqlForAgentHost } from "../support/pg.js";

const maybe = clusterTestsEnabled() ? describe : describe.skip;

const NS = process.env.PLATFORM_NS ?? "agent-sandbox";
// The front door (Service `agent-host` → the router), the same path the UI and broker use.
const AGENT_HOST = `http://agent-host.${NS}.svc.cluster.local:8080`;

type Psql = (query: string) => Promise<string>;

/** SQL string literal. Conversation ids are server-minted UUIDs, but a quote in an
 *  interpolated id would silently change the statement rather than fail it. */
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

async function createConversation(cluster: Cluster): Promise<string> {
  const res = await cluster.curlJson<{ id?: string }>(`${AGENT_HOST}/conversations`, {
    method: "POST",
    headers: ["Content-Type: application/json"],
    body: "{}",
    timeoutMs: 60_000,
  });
  expect(res.id, `POST /conversations returned no id: ${JSON.stringify(res)}`).toBeTruthy();
  return res.id as string;
}

/** Prompt a conversation and wait for the SSE stream to close. */
async function sendTurn(cluster: Cluster, threadId: string, runId: string, text: string): Promise<void> {
  await cluster.curlInCluster(`${AGENT_HOST}/agui`, {
    method: "POST",
    headers: ["Content-Type: application/json", "Accept: text/event-stream"],
    body: JSON.stringify({ threadId, runId, messages: [{ id: `m-${runId}`, role: "user", content: text }] }),
    timeoutMs: 120_000,
  });
}

const countEvents = async (psql: Psql, id: string): Promise<number> =>
  Number(await psql(`SELECT count(*) FROM conversation_events WHERE conversation_id = ${lit(id)}`));

const maxSeq = async (psql: Psql, id: string): Promise<number> =>
  Number((await psql(`SELECT coalesce(max(seq), 0) FROM conversation_events WHERE conversation_id = ${lit(id)}`)) || 0);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the row count stops moving, and return it.
 *
 * `appendEvent` is void-called onto a per-conversation chain, so the SSE stream closing does
 * not mean the last event has committed. Polling to QUIESCENCE rather than sleeping a fixed
 * amount is what keeps the count assertions below meaningful instead of racy.
 */
async function settledEventCount(psql: Psql, id: string, timeoutMs = 60_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const n = await countEvents(psql, id);
    stable = n === last && n > 0 ? stable + 1 : 0;
    last = n;
    if (stable >= 2) return n;
    await sleep(1_500);
  }
  throw new Error(`event count for ${id} never settled within ${timeoutMs}ms (last=${last})`);
}

/** agent-host logs across every replica — the conversation can be hosted by any of them. */
const agentHostLogs = async (sinceSeconds: number): Promise<string> =>
  kubectl([
    "logs", "-n", NS, "-l", "app=agent-host",
    "--tail=-1", `--since=${sinceSeconds}s`, "--max-log-requests=10",
  ]).catch(() => "");

const linesFor = (logs: string, id: string, msg: string): string[] =>
  logs.split("\n").filter((l) => l.includes(id) && l.includes(msg));

maybe("conversation event log — durability", () => {
  let cluster: Cluster;
  let psql: Psql;

  beforeAll(async () => {
    cluster = await withCluster({ namespace: NS });
    psql = await psqlForAgentHost(NS);
  });

  it("DELETE drops the conversation_events rows, not just the conversation", async () => {
    const id = await createConversation(cluster);
    await sendTurn(cluster, id, "r1", "hello");

    const before = await settledEventCount(psql, id);
    expect(before, "the turn produced no event rows — nothing to prove about DELETE").toBeGreaterThan(0);

    await cluster.curlInCluster(`${AGENT_HOST}/conversations/${id}`, { method: "DELETE", timeoutMs: 60_000 });

    // Poll rather than assert once: end() tears the conversation down across several stores,
    // and only the row count is the durable answer.
    const deadline = Date.now() + 60_000;
    let left = before;
    while (Date.now() < deadline) {
      left = await countEvents(psql, id);
      if (left === 0) break;
      await sleep(2_000);
    }

    expect(
      left,
      `DELETE left ${left} of ${before} conversation_events rows for ${id}. Those rows keep an ` +
        `orphan RUN_STARTED that adoption rediscovers, and they hold the log of a conversation ` +
        `the user asked to erase.`,
    ).toBe(0);
  });

  it("a seq collision is recovered: the turn survives and the log has no gap", async () => {
    const id = await createConversation(cluster);

    // Turn 1 warms the conversation (pod provisioning, and any first-turn-only events).
    await sendTurn(cluster, id, "r1", "first");
    await settledEventCount(psql, id);

    // Turn 2 CALIBRATES: how many events one ordinary turn appends on this deployment. Asserting
    // against a hardcoded number would pin the fake agent's script, which is not the invariant.
    const beforeCalib = await maxSeq(psql, id);
    await sendTurn(cluster, id, "r2", "second");
    await settledEventCount(psql, id);
    const perTurn = (await maxSeq(psql, id)) - beforeCalib;
    expect(perTurn, "the calibration turn appended nothing — the fake agent is not replying").toBeGreaterThan(0);

    // Force the collision. The rival row takes the seq the owning pod has cached as "next", so
    // its following append hits the PK — the two-writers state the fence admits by design.
    //
    // Up to two attempts: the premise is that the owning pod still holds a cached head, which a
    // reassignment between turns would discard. A miss is retried rather than asserted away.
    let collided: string[] = [];
    let rivalSeq = 0;
    let runSeq = 2;
    for (let attempt = 1; attempt <= 2 && collided.length === 0; attempt++) {
      const at = await maxSeq(psql, id);
      rivalSeq = at + 1;
      const prev = await psql(
        `SELECT checksum FROM conversation_events WHERE conversation_id = ${lit(id)} ORDER BY seq DESC LIMIT 1`,
      );
      // A plausible event, not a real one: the test asserts on seq continuity and event counts,
      // never on this row's content. Its checksum deliberately continues the chain so the rows
      // after it are chained the way a real rival's would be.
      await psql(
        `INSERT INTO conversation_events (conversation_id, seq, event, checksum, prev_checksum) VALUES (` +
          `${lit(id)}, ${rivalSeq}, ` +
          `'{"type":"CUSTOM","name":"rival-writer","value":"forced collision (test)"}'::jsonb, ` +
          `${lit(`rival-${rivalSeq}-${Date.now().toString(36)}`)}, ${lit(prev)})`,
      );

      runSeq += 1;
      await sendTurn(cluster, id, `r${runSeq}`, "after the collision");
      await settledEventCount(psql, id);
      collided = linesFor(await agentHostLogs(900), id, "append collided");
    }

    // ANTI-VACUITY. Without this the test passes when the collision never happened — which is
    // precisely how a green flake check can mean nothing.
    expect(
      collided.length,
      `no "append collided" was logged for ${id}: the injected row at seq ${rivalSeq} never ` +
        `collided, so this test exercised nothing. Do not read it as a pass.`,
    ).toBeGreaterThan(0);

    const logs = await agentHostLogs(900);
    // Deliberately NOT asserting that the fence never refused: a reassignment mid-test refuses
    // the old owner legitimately, and the new owner still serves the turn. `turn lost` is the
    // failure; a refusal is not.
    expect(
      linesFor(logs, id, "durable append FAILED"),
      "the collision lost a turn — the retry did not recover the event",
    ).toEqual([]);

    // The turn after the collision landed in full. `>=` not `===`: a dropped event is the bug,
    // an extra one is not.
    const finalMax = await maxSeq(psql, id);
    expect(
      finalMax - rivalSeq,
      `only ${finalMax - rivalSeq} events were appended after the forced collision, against ` +
        `${perTurn} for an uncontested turn — the collision cost the conversation events.`,
    ).toBeGreaterThanOrEqual(perTurn);

    // No gap: seq is 1..max with nothing missing, so the retry re-chained rather than skipping.
    const total = await countEvents(psql, id);
    expect(
      total,
      `conversation_events for ${id} has max(seq)=${finalMax} but ${total} rows — the log has a gap.`,
    ).toBe(finalMax);
  });
});
