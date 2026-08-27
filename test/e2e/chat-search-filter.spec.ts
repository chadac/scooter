/**
 * Tier 3 E2E — sidebar chat search, provider filter, and Titles/Links label mode.
 *
 * Two conversations: one linked to a GitHub PR (pushed via the links API, as a
 * webhook would), one plain. Exercises (1) keyword search over title + link name,
 * (2) the provider filter chips, and (3) the Titles/Links toggle that swaps a row's
 * conversation title for its linked-resource name.
 */

import { test, expect } from "./fixtures.js";
import { isFull } from "./target.js";

const sb = {
  item: '[data-testid="session-item"]',
  title: '[data-testid="session-title"]',
  search: '[data-testid="session-search"]',
  filtersToggle: '[data-testid="filters-toggle"]',
  providerGithub: '[data-testid="provider-github"]',
  labelTitle: '[data-testid="label-title"]',
  labelGithub: '[data-testid="label-github"]',
  labelSlack: '[data-testid="label-slack"]',
  empty: '[data-testid="session-empty"]',
  scopeAll: '[data-testid="scope-all"]',
};

async function currentThreadId(page: import("@playwright/test").Page): Promise<string> {
  // Poll for serverId with retries — it's set asynchronously after the conversation
  // is created on the server, so there's a race between the reply arriving and the
  // serverId being persisted to localStorage.
  // 150 × 100ms = 15s: the fast stack lands serverId in well under the old 5s
  // budget, but on the full (cluster) target the create round-trips the router
  // to the owning agent-host pod, so give the persistence race real room.
  let id = "";
  for (let i = 0; i < 150; i++) {
    id = await page.evaluate(() => {
      const raw = window.localStorage.getItem("kubenix-agent.sessions.v1");
      // The SERVER's id, not `currentId` — that is the stable local KEY, which for a
      // conversation created on its first send is a placeholder the server never issued.
      if (!raw) return "";
      const st = JSON.parse(raw) as {
        currentId?: string;
        sessions?: Array<{ id: string; serverId?: string }>;
      };
      return st.sessions?.find((s) => s.id === st.currentId)?.serverId ?? "";
    });
    if (id) break;
    await page.waitForTimeout(100);
  }
  expect(id).toBeTruthy();
  return id;
}

test.describe("sidebar search + filter + label mode", () => {
  test("search, provider chips, and the Titles/Links toggle", async ({ chat, page, request, baseURL }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75 for the pattern). This test
    // creates TWO conversations, and on the full target each first reply is gated
    // on a REAL sandbox boot (5-25s cold) before the fake agent's echo tool call
    // can run — and CI forces CONVERSATION_POD_CAP=1, so A and B land on
    // DIFFERENT pods and NEITHER boot is warm. Arithmetic: 2 × (provision 15-25s
    // + turn ~2s) + the sidebar link-merge poll (30s worst) + the label-mode poll
    // (30s worst) ≈ 115-145s worst case — far past the 60s default that was
    // written against the ~1s fake stack.
    // 360s, not 240: the two row waits below now allow 90s each for the sidebar's
    // aggregated list to settle during pod churn, on top of the two 90s replies.
    test.setTimeout(360_000);
    const base = baseURL ?? "http://localhost:5173";
    // A per-run nonce on the GITHUB LINK NAME (a title this test sets explicitly, so it
    // is stable). On the full target `scope=all` shows the whole multi-replica fleet, so
    // an unscoped title search also matches leftovers from other specs and from earlier
    // attempts of this one — observed on CI: searching "#203" correctly hid THIS test's
    // plain row, but a foreign /scratch/i row was still on screen and toHaveCount(0)
    // failed while the filter worked. The nonce keeps the link-name assertions naming
    // exactly this run's conversation. The two ROWS are pinned by server id instead
    // (see below) — a derived conversation title is not something the test controls.
    const nonce = `n${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

    // Conversation A: will be linked to a GitHub PR. 90s reply budget: cold
    // sandbox provision (up to ~25s, longer when the CI node is briefly out of
    // cpu) precedes the fake agent's real echo exec.
    await chat.open();
    await chat.send(`investigate the flaky broker test ${nonce}`);
    await chat.waitForReply(/dummy agent/i, 90_000);
    const threadA = await currentThreadId(page);
    const linkBody = {
      source: "github",
      resourceType: "pull_request",
      url: "https://github.com/example-org/example-app/pull/203",
      // Nonce here too: the label-mode assertions below count rows showing this LINK
      // name, and on the shared fleet a resurfaced row from an earlier attempt would
      // carry the identical title and break an exact count.
      title: `example-org/example-app #203 ${nonce}`,
    };
    // RETRY the link POST, and report the STATUS when it never takes.
    //
    // This is setup, not the behaviour under test — everything below asserts how the
    // sidebar FILTERS an existing link. On CI it failed here with a bare
    // "expect(received).toBeTruthy() / Received: false", which says nothing about why:
    // the conversation was healthy in the snapshot (its turn had completed normally), so
    // this was a transient write against the fleet, and the assertion threw away the one
    // piece of evidence that would identify it. The write is idempotent enough to repeat —
    // it names the same conversation, source, and url each time.
    let r = await request.post(`${base}/conversations/${threadA}/links`, { data: linkBody });
    for (let i = 0; i < 4 && !r.ok(); i++) {
      await page.waitForTimeout(2_000);
      r = await request.post(`${base}/conversations/${threadA}/links`, { data: linkBody });
    }
    // Read the body ONLY on failure. `expect(cond, msg)` builds its message eagerly, so
    // awaiting r.text() inline consumes the response on the SUCCESS path too.
    if (!r.ok()) {
      const why = await r.text().catch(() => "");
      expect(r.ok(), `linking conversation A failed: ${r.status()} ${why}`).toBeTruthy();
    }

    // Conversation B: plain, no links. Same 90s budget — under podCap=1 this
    // conversation provisions its own sandbox on another pod (no warm reuse).
    await page.locator('[data-testid="new-session"]').click();
    await chat.send(`just some scratch notes ${nonce}`);
    await chat.waitForReply(/dummy agent/i, 90_000);
    const threadB = await currentThreadId(page);

    // Rows pinned by their SERVER ID, not by title text or absolute position — the same
    // shared-backend discipline linked-resources.spec.ts documents for its data-active
    // row. On the full target the backend is a multi-replica fleet: a conversation
    // another actor deleted can transiently resurface from a pod the aggregate list had
    // skipped (observed on CI — three deleted smoke conversations reappeared mid-test),
    // so an unscoped count asserts fleet hygiene, not the filter behaviour under test.
    //
    // The id, not the title: a row's visible text is the DERIVED title (first message,
    // sliced to 60 chars) which the agent may later OVERRIDE with its own — so matching
    // on the prompt text is not guaranteed to keep matching (a nonce carried in the
    // prompt did not survive into the row and every locator resolved to 0 elements).
    // data-conversation-id is the server's own identifier and cannot drift.
    const rowA = page.locator(`${sb.item}[data-conversation-id="${threadA}"]`);
    const rowB = page.locator(`${sb.item}[data-conversation-id="${threadB}"]`);

    // Open the advanced-filters panel (Scope / Linked / Show live inside it).
    await page.locator(sb.filtersToggle).click();
    // Show all conversations (both rows regardless of owner).
    await page.locator(sb.scopeAll).click();
    // POLL for both rows rather than asserting once. The sidebar is fed by the router's
    // aggregated conversation list, which degrades to a PARTIAL list while pods churn
    // (the platform dump for the failing run shows repeated "resume-on-missing-pod
    // failed" plus autoscale down) — so a row that exists can be absent from one
    // refresh. Observed on CI: rowA resolved to 0 for the full 30s while the
    // conversation was healthy. Re-reading until both rows land measures the FILTER,
    // which is what this test is about, not the fleet's list-refresh timing.
    await expect(rowA).toHaveCount(1, { timeout: 90_000 });
    await expect(rowB).toHaveCount(1, { timeout: 90_000 });
    // On the deterministic fast stack (one wiped single-process backend) the two
    // rows are also provably the ONLY rows.
    if (!isFull) await expect(page.locator(sb.item)).toHaveCount(2);

    // (1) Keyword search matches the LINK NAME (not present in either title):
    // the linked row stays, the plain row is filtered OUT.
    // 90s, matching the row waits above. This is the FIRST assertion that depends on the
    // sidebar's LINK-merge poll — "#203" appears only in the link name, never in a title —
    // and that merge is a separate refresh from the one that delivered the rows. On a shard
    // where this spec runs first the whole cluster is cold, so the merge lands later still.
    // Observed on CI: rowA resolved to 0 for the full 30s as test #1 on a fresh shard.
    await page.locator(sb.search).fill("#203");
    await expect(rowA, "the link name must be searchable once the merge lands").toHaveCount(1, {
      timeout: 90_000,
    });
    await expect(rowB).toHaveCount(0, { timeout: 30_000 });
    if (!isFull) await expect(page.locator(sb.item)).toHaveCount(1);

    // Search matches a plain title too (and drops the non-matching linked row).
    // Same 30s budget as the "#203" assertion above, and for the same reason: this row
    // has to be present in the aggregated list AT THE MOMENT the query is applied, and
    // that list degrades to a PARTIAL one while pods churn. Observed on CI: rowB
    // resolved to 0 for the full default 15s here while its sibling assertions — the
    // ones that were given an explicit budget — passed in the same run.
    await page.locator(sb.search).fill("scratch");
    await expect(rowB).toHaveCount(1, { timeout: 30_000 });
    await expect(rowA).toHaveCount(0, { timeout: 30_000 });
    // A non-matching query yields the empty-state.
    //
    // Wait for THIS TEST'S rows to be filtered out first. `session-empty` only renders when
    // the list has zero rows (Sidebar.tsx), so it cannot appear while any row is still on
    // screen — including one whose removal is simply a re-render behind. CI failed here with
    // conversation B's row still listed under the "zzz-nomatch" query: the filter had not
    // repainted yet, and asserting the empty-state directly turned that into a 30s timeout
    // that named the wrong thing. Polling the rows first makes the wait land on the filter
    // taking effect, and keeps the empty-state assertion as the real check afterwards.
    await page.locator(sb.search).fill("zzz-nomatch");
    await expect(rowA).toHaveCount(0, { timeout: 30_000 });
    await expect(rowB).toHaveCount(0, { timeout: 30_000 });
    // The EMPTY-STATE itself is fast-only. It renders only when the sidebar has zero rows,
    // and on the full target the list is the whole shared fleet — another spec's conversation
    // legitimately sitting there keeps the count above zero no matter how correct this
    // filter is. What this test owns is that ITS OWN rows are filtered out, asserted above
    // on both targets; the empty-state is provable only where the backend holds nothing else.
    if (!isFull) await expect(page.locator(sb.empty)).toBeVisible({ timeout: 30_000 });
    await page.locator(sb.search).fill("");

    // (2) Provider filter (icon chips): GitHub keeps the linked conversation and
    // drops the unlinked one.
    // Explicit budgets for the same reason as the search assertions above: every one of
    // these reads the aggregated list at the moment the chip is toggled, and that list is
    // allowed to be transiently partial on the full target.
    // Both rows must be BACK from the cleared search before the chip is applied. The search
    // above emptied the list, and clearing the query repopulates it on the sidebar's own
    // refresh — clicking the chip against a list that has not repopulated yet filters
    // nothing into nothing. CI showed the compound state: "No chats match." with a filter
    // still active and rowA absent for the full budget.
    await expect(rowA, "the rows must return after the search is cleared").toHaveCount(1, { timeout: 60_000 });
    await expect(rowB, "the rows must return after the search is cleared").toHaveCount(1, { timeout: 60_000 });

    await page.locator(sb.providerGithub).click();
    await expect(rowA).toHaveCount(1, { timeout: 30_000 });
    await expect(rowB).toHaveCount(0, { timeout: 30_000 });
    if (!isFull) await expect(page.locator(sb.item)).toHaveCount(1);
    await page.locator(sb.providerGithub).click(); // toggle off
    await expect(rowB).toHaveCount(1, { timeout: 30_000 });
    await expect(rowA).toHaveCount(1, { timeout: 30_000 });
    if (!isFull) await expect(page.locator(sb.item)).toHaveCount(2);

    // (3) "Show" segmented control -> GitHub: the linked row shows the PR name; the
    // unlinked row falls back to its title.
    // Assert on the pinned ROWS' own title elements, not on a fleet-wide title search:
    // the link name is one this test set (so its nonce is reliable), but a row's DERIVED
    // title is not something the test controls.
    await page.locator(sb.labelGithub).click();
    await expect(rowA.locator(sb.title)).toHaveText(
      new RegExp(`example-org/example-app #203 ${nonce}`, "i"),
      { timeout: 30_000 },
    );
    // The unlinked row has no GitHub name to show, so it falls back to its own title.
    await expect(rowB.locator(sb.title)).not.toHaveText(
      new RegExp(`example-org/example-app #203 ${nonce}`, "i"),
    );
    // Under a provider the linked row doesn't have (Slack), it falls back to its title.
    await page.locator(sb.labelSlack).click();
    await expect(rowA.locator(sb.title)).not.toHaveText(
      new RegExp(`example-org/example-app #203 ${nonce}`, "i"),
      { timeout: 30_000 },
    );
    // Back to the Scooter/title mode: the linked row shows its conversation title again.
    await page.locator(sb.labelTitle).click();
    await expect(rowA.locator(sb.title)).not.toHaveText(
      new RegExp(`example-org/example-app #203 ${nonce}`, "i"),
      { timeout: 30_000 },
    );
  });
});
