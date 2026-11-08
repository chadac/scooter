/**
 * e2e for the PgBouncer pooler in front of the shared Postgres. Pooled consumers reach
 * the server through agent-shared-db-pooler in transaction mode; the session clients
 * (the router's push LISTEN, agent-host's ownership LISTEN) must bypass it, since a
 * transaction-mode pooler drops a LISTEN at the end of its transaction. The cluster is
 * read through the rollout hook, which runs kubectl the browser cannot.
 */

import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures.js";
import { fullOnly } from "./target.js";

interface Connection {
  user: string;
  addr: string;
  query: string;
  viaPooler: boolean;
}

interface Connections {
  poolerIps: string[];
  connections: Connection[];
}

const HOOK = process.env.E2E_ROLLOUT_HOOK ?? "";

async function connections(request: APIRequestContext): Promise<Connections> {
  const res = await request.get(`${HOOK}/db/connections`);
  expect(res.ok(), `the hook must list connections: ${await res.text()}`).toBeTruthy();
  return (await res.json()) as Connections;
}

const isListen = (c: Connection) => /^\s*LISTEN\b/i.test(c.query);

fullOnly("needs the real platform's pooler and kubectl access to the database")(
  "the PgBouncer pooler",
  () => {
    test.beforeEach(() => {
      test.setTimeout(300_000);
      test.skip(!HOOK, "no rollout hook configured for this run");
    });

    test("pooled queries go through PgBouncer and every LISTEN bypasses it", async ({ chat, request }) => {
      // A finished turn has written events and ownership rows, so both paths are live.
      await chat.open();
      await chat.completeTurn("exercise the database");

      await expect
        .poll(async () => (await connections(request)).connections.some((c) => c.viaPooler && c.user === "agent_host"), {
          timeout: 60_000,
          message: "agent_host queries must arrive from the pooler",
        })
        .toBe(true);

      const { poolerIps, connections: conns } = await connections(request);
      expect(poolerIps.length, "the pooler must be running").toBeGreaterThan(0);
      const listens = conns.filter(isListen);
      expect(listens.length, "the router and agent-host must hold LISTEN sessions").toBeGreaterThan(0);
      expect(listens.filter((c) => c.viaPooler), "no LISTEN may go through the pooler").toEqual([]);
    });

    test("live updates still reach the browser after a reload", async ({ chat, page }) => {
      // Two turns in one tab ride the router's push LISTEN; the reload reads back through
      // the pooler, so a dropped write or a lost notification shows up here.
      await chat.open();
      await chat.completeTurn("first through the pooler");
      await chat.completeTurn("second through the pooler");
      const url = page.url();

      await page.goto(url);
      await expect(chat.userMessages()).toHaveCount(2, { timeout: 60_000 });
      await expect.poll(() => chat.assistantMessages().count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
    });

    test("a conversation survives the pooler restarting", async ({ chat, page, request }) => {
      // Pooled clients must reconnect once the replaced pooler pod is ready.
      await chat.open();
      await chat.completeTurn("before the pooler restart");
      const url = page.url();

      const restarted = await request.post(`${HOOK}/pooler/restart`, { timeout: 200_000 });
      expect(restarted.ok(), `the hook must restart the pooler: ${await restarted.text()}`).toBeTruthy();

      await page.goto(url);
      await expect(chat.userMessages().first()).toBeVisible({ timeout: 60_000 });
      await chat.completeTurn("after the pooler restart");
      await page.goto(url);
      await expect(chat.userMessages()).toHaveCount(2, { timeout: 60_000 });
    });
  },
);
