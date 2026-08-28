/**
 * Tier 3 E2E (full only) — a suspended sandbox whose warm-store PVC was GC'd still revives.
 *
 * THE INCIDENT (odin, 2026-08-22). A suspended sandbox's spec referenced a pooled
 * `warm-store-*` PVC that the warm-store pool was reclaiming. Waking it (a plain
 * operatingMode=Running flip) recreated the pod pointing at that PVC: Pending forever, no
 * error surfaced anywhere, the conversation simply never woke. The DOMINANT live variant is
 * a claim that is TERMINATING (a deletionTimestamp is set, a finalizer still holds it, so it
 * READS 200) — "persistentvolumeclaim … is being deleted" (3 of 4 wedges one evening); the
 * rarer variant is a clean 404. The hook here reproduces the terminating shape (see
 * rolloutHook.py `/gc-warmstore`) so this exercises the case a 404-only probe would miss.
 *
 * The fix HEALS the dead claim before the flip, on BOTH wake-to-Running paths — resume()
 * (revive of an in-memory suspended conversation) and create()'s adopt-existing 409 branch
 * (revive after an agent-host restart, when the conversation hydrates with a placeholder ref
 * and takes the create path). This test drives the REAL cluster lifecycle through the resume
 * path — the deterministic, non-disruptive one — and asserts the recovery guarantee end to
 * end. Both paths share the same healWarmStoreClaim() helper; the create-adopt branch is
 * additionally pinned in isolation by test/contract/provisioner-adopt-heal.spec.ts. (An
 * earlier revision restarted the whole agent-host here to force the adopt path in-cluster,
 * but a full rollout churns every pod and destabilises the router for other specs in the
 * shard — not worth it when a contract test already covers that branch deterministically.)
 *
 * Without the heal: the revive flips operatingMode against a spec naming a missing PVC, the
 * pod Pendings forever, and the turn never completes — this test times out (RED). With it,
 * the turn recovers (GREEN).
 *
 * full-only: needs a real sandbox with an overlay upper AND kubectl (the rollout hook) to
 * rewrite the Sandbox spec + delete the PVC out of band. The fake stack has neither.
 */
import { expect } from "@playwright/test";

import { test } from "./fixtures.js";
import { fullOnly } from "./target.js";

fullOnly("needs a real sandbox + kubectl to GC a warm-store PVC out of band")(
  "warm-store heal on revive",
  () => {
    // Two cold sandbox boots (the initial turn + the post-GC revive) — well past the 60s
    // suite default.
    test.beforeEach(() => test.setTimeout(300_000));

    test("a suspended sandbox whose warm-store PVC was GC'd revives and runs", async ({
      chat,
      page,
      baseURL,
      request,
    }) => {
      const hook = process.env.E2E_ROLLOUT_HOOK ?? "";
      const base = (baseURL ?? "").replace(/\/$/, "");

      // 1. A live conversation with a real sandbox + overlay upper.
      await chat.open();
      await chat.completeTurn("before the nap");
      const thread = new URL(page.url()).searchParams.get("thread");
      expect(thread, "the URL must name a conversation").toBeTruthy();

      // 2. Suspend for real (drops the bridge + pod; the Sandbox object + PVCs remain).
      const suspended = await request.post(
        `${base}/conversations/${encodeURIComponent(thread!)}/suspend`,
      );
      expect(suspended.ok(), "suspend must succeed").toBeTruthy();

      // 3. Recreate the incident on the suspended sandbox: repoint its scooter-rw overlay
      //    upper at a warm-store-* PVC that is TERMINATING (exists, deletionTimestamp set,
      //    finalizer-held, labelled as this sandbox's own), and delete the real upper out of
      //    band. Skips cleanly if no hook is wired, or the sandbox has no overlay upper.
      const gc = await request
        .post(`${hook}/gc-warmstore/${encodeURIComponent(thread!)}`)
        .catch(() => null);
      test.skip(!gc?.ok(), "no rollout hook configured (or the sandbox has no overlay upper)");

      // 4. THE ASSERTION: the next turn must revive the sandbox — heal the dead warm-store
      //    claim, re-bind a fresh upper, wake the pod — and run to completion within budget.
      await page.goto(page.url());
      await expect(chat.input()).toBeVisible({ timeout: 60_000 });
      await expect(chat.userMessages().first()).toBeVisible({ timeout: 60_000 });
      await chat.completeTurn("after the GC — this must still run");
      await expect
        .poll(async () => chat.userMessages().count(), { timeout: 30_000 })
        .toBeGreaterThanOrEqual(2);
    });
  },
);
