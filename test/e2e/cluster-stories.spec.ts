/**
 * User stories that ONLY a real cluster can express.
 *
 * These are the reason Tier 2 exists. The fake stack has one agent-host, no router and
 * no rollout, so it cannot express multi-pod routing or a deploy landing mid-turn —
 * and a bug in either is invisible to all 122 Tier-3 tests. That is how a conversation
 * ended up streaming against one id while the URL named another: the browser and the
 * real server never met in CI.
 *
 * Everything else worth running against a cluster is an EXISTING spec — 26 of 31 are
 * portable as-is. Do not duplicate them here; select them with the `cluster` project.
 */
import { expect } from "@playwright/test";

import { test } from "./fixtures.js";
import { fullOnly } from "./target.js";

fullOnly("needs multiple agent-host pods behind the router")(
  "multi-pod conversation routing",
  () => {
    test("a conversation stays reachable no matter which pod the router picks", async ({ chat, page }) => {
      await chat.open();
      await chat.completeTurn("first turn");
      const url = page.url();

      // Re-entering through the front door may land on a DIFFERENT pod than the owner.
      // The router must still reach the owning pod; a per-pod view would show an empty
      // conversation here — the shape of the "GET /conversations returns one pod's
      // slice" bug that reached production.
      for (let i = 0; i < 3; i++) {
        await page.goto(url);
        await expect(chat.input()).toBeVisible({ timeout: 30_000 });
        await expect(chat.userMessages().first()).toBeVisible({ timeout: 30_000 });
      }

      // And it must still be LIVE, not merely readable.
      await chat.completeTurn("second turn after re-routing");
      await expect.poll(async () => chat.userMessages().count(), { timeout: 30_000 }).toBe(2);
    });
  },
);

fullOnly("needs a real rollout to restart pods under a live conversation")(
  "a deploy during a live conversation",
  () => {
    test("a conversation survives its host pod being replaced", async ({ chat, page, request }) => {
      // THE REPORTED FAILURE: a rollout landed seconds after a conversation was created.
      // The stream went dead, no more events arrived, and refreshing lost it entirely.
      // Nothing tests this today, in any tier.
      await chat.open();
      await chat.completeTurn("before the rollout");
      const url = page.url();
      const thread = new URL(url).searchParams.get("thread");
      expect(thread, "the URL must name a conversation").toBeTruthy();

      // Restart agent-host out of band (the CI job grants kubectl access).
      const restarted = await request.post(`${process.env.E2E_ROLLOUT_HOOK ?? ""}/restart`).catch(() => null);
      test.skip(!restarted?.ok(), "no rollout hook configured for this run");

      await page.goto(url);
      await expect(chat.input()).toBeVisible({ timeout: 60_000 });

      // The conversation must still exist, still be named by the URL, and still work.
      expect(new URL(page.url()).searchParams.get("thread")).toBe(thread);
      await expect(chat.userMessages().first()).toBeVisible({ timeout: 60_000 });
      await chat.completeTurn("after the rollout");
    });
  },
);

fullOnly("needs kubectl access to delete the owner pod mid-run")(
  "the conversation MOVES pods mid-run",
  () => {
    test("the owner pod dies mid-run; the UI recovers and keeps communicating", async ({ chat, page, request }) => {
      // THE SCALE-DOWN/ROLLOUT EVENT, ON DEMAND (e2e-full run 33015148191): the pod
      // hosting a live run is deleted under it. The controller must reassign, the
      // new owner must revive + finish (or cleanly resume) the stranded run, and —
      // the part the user actually feels — the SAME browser tab must end up idle
      // and able to run another turn. Before the deletion-cost + dangling-run
      // fixes this exact sequence left "Working…" on screen forever.
      test.setTimeout(300_000);
      const hook = process.env.E2E_ROLLOUT_HOOK ?? "";
      test.skip(!hook, "no rollout hook configured for this run");

      await chat.open();
      await chat.completeTurn("before the move", 100_000);
      const thread = new URL(page.url()).searchParams.get("thread");
      expect(thread, "the URL must name a conversation").toBeTruthy();

      // A turn long enough that the pod deletion lands MID-run.
      await chat.send("!sleep 15");
      await expect(page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
      const moved = await request.post(`${hook}/move/${thread}`);
      expect(moved.ok(), `the hook must delete the owner pod: ${await moved.text()}`).toBeTruthy();

      // The run must reach a terminal state — completed by the resumed run or ended
      // cleanly — well within the reassign + revive + resume budget. "Forever" is
      // the bug; a bounded wait is the contract.
      await expect(page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout: 180_000 });

      // And the conversation is still THIS conversation, still alive.
      expect(new URL(page.url()).searchParams.get("thread")).toBe(thread);
      await chat.completeTurn("after the move", 100_000);
    });
  },
);
