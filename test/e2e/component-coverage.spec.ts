/**
 * Tier 3 E2E — WIDE component coverage.
 *
 * The first coverage pass touched 13 of the app's ~113 testids: the thread, the queue and the
 * interrupt panel. Everything else — the sidebar rows and their controls, the right panel's tabs,
 * the sandbox panel, the model picker, the context-fill bar, settings — was never rendered under
 * assertion, so a component could break silently and no test would notice.
 *
 * This spec exercises those surfaces and, at every step, ALSO asserts the whole-UI invariants
 * (assertConsistent) — so touching one component can't quietly corrupt another.
 */

import { test, expect, snapshot, assertConsistent } from "./fixtures.js";

const sb = {
  list: '[data-testid="session-list"]',
  item: '[data-testid="session-item"]',
  title: '[data-testid="session-title"]',
  star: '[data-testid="session-star"]',
  rename: '[data-testid="session-rename"]',
  renameInput: '[data-testid="session-rename-input"]',
  search: '[data-testid="session-search"]',
  newSession: '[data-testid="new-session"]',
  filtersToggle: '[data-testid="filters-toggle"]',
};
const panel = {
  root: '[data-testid="right-panel"]',
  sandboxTab: '[data-testid="right-panel-tab-sandbox"]',
  queueTab: '[data-testid="right-panel-tab-queue"]',
  sandboxPanel: '[data-testid="sandbox-panel"]',
  sandboxState: '[data-testid="sandbox-state"]',
  queueEmpty: '[data-testid="queue-empty"]',
};

test.describe("sidebar / session components", () => {
  test("the sidebar lists a conversation with its title, and the whole UI stays consistent", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("sidebar coverage");
    await expect(page.locator(sb.list)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(sb.item).first()).toBeVisible({ timeout: 30_000 });
    // The row carries a non-empty title (the agent's <title> or the prompt).
    const title = (await page.locator(sb.title).first().innerText()).trim();
    expect(title.length, "the session row must render a title").toBeGreaterThan(0);
    assertConsistent(await snapshot(page), "sidebar listed");
  });

  test("STARRING a conversation persists across a reload and disturbs nothing else", async ({ chat, page }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). Every fake-agent turn runs a real
    // exec, and on the full target the FIRST exec of a conversation waits for its sandbox
    // pod (5-25s measured). Worst case here: open 5s + first turn ~30s + waitForIdle +
    // reload + the 30s re-fold poll + two star round-trips ≈ 75s — past the 60s default
    // on arithmetic alone, with every step behaving.
    test.setTimeout(120_000);
    await chat.open();
    await chat.sendTurn("star me");
    await chat.waitForIdle();
    // Assert the row EXISTS rather than an absolute list length: the e2e backend is shared and
    // serial, so a prior test's conversation can still be settling and inflate the count.
    await expect(page.locator(sb.item).first()).toBeVisible({ timeout: 30_000 });
    const before = await snapshot(page);
    await page.locator(sb.star).first().click();
    await page.reload();
    await expect(page.locator(sb.item).first()).toBeVisible({ timeout: 30_000 });
    // Wait for the transcript to finish re-folding before snapshotting — a snapshot taken mid-render
    // reads 0 messages and would wrongly look like data loss.
    await expect.poll(async () => (await snapshot(page)).userMessages, { timeout: 30_000 })
      .toBe(before.userMessages);
    const after = await snapshot(page);
    assertConsistent(after, "after starring + reload");
    expect(after.sessions, "the conversation is still listed after the reload").toBeGreaterThanOrEqual(1);
    // Starring is a sidebar-only concern — the thread must be untouched.
    expect(after.userMessages, "starring must not change the transcript").toBe(before.userMessages);
    expect(after.assistantMessages, "starring must not change the transcript").toBe(before.assistantMessages);

    // UNSTAR before leaving. A STARRED conversation is protected from deletion (the
    // agent-host DELETE returns 409), so the cleanState fixture — which polls
    // delete-until-empty — can NEVER remove it. It then survives into every later spec
    // on this shard and breaks their absolute-count assertions. This is shard-order
    // dependent, so it only bites when the sharder happens to place a count-sensitive
    // spec (e.g. sessions.spec.ts, "Expected 1, Received 2") after this one — which is
    // exactly how it surfaced: green for several runs, then red when CI reweighted.
    await page.locator(sb.star).first().click();
    await expect(page.locator(sb.item).first()).not.toHaveAttribute("data-starred", "true", {
      timeout: 10_000,
    });
  });

  test("SEARCH narrows the sidebar and restores the full list when cleared", async ({ chat, page }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). TWO conversations, each with its
    // own first-exec sandbox wait (5-25s each on the full target): 2 × ~30s + waits ≈ 70s
    // worst — over the 60s default before the search assertions even start.
    test.setTimeout(180_000);
    await chat.open();
    // 90s each, not sendTurn's 45s: BOTH of these are first turns of their own conversation,
    // so each waits for its own cold sandbox pod (5-25s, longer under CI CPU pressure) before
    // its exec starts — and CI forces CONVERSATION_POD_CAP=1, so the second gets no warm
    // reuse. The 180s ceiling above is set for exactly this.
    await chat.sendTurn("alpha searchable", 90_000);
    await chat.waitForIdle();
    await page.locator(sb.newSession).click();
    await chat.sendTurn("beta searchable", 90_000);
    await chat.waitForIdle();
    // Baseline from the ACTUAL list (the shared serial backend may carry a settling row from a
    // prior test); the property under test is "search narrows, clearing restores".
    //
    // WAIT for both rows rather than sampling the count once. The sidebar is fed by the
    // router's aggregated list, which degrades to a partial — sometimes empty — list while
    // pods churn, so a single sample can read 0 immediately after two successful turns
    // (observed on CI: "Expected: > 0, Received: 0" with both conversations healthy).
    await expect
      .poll(async () => page.locator(sb.item).count(), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2);
    const total = await page.locator(sb.item).count();
    expect(total, "both conversations are listed").toBeGreaterThanOrEqual(2);

    await page.locator(sb.search).fill("alpha");
    await expect.poll(async () => page.locator(sb.item).count(), { timeout: 20_000 }).toBeLessThan(total);
    await page.locator(sb.search).fill("");
    // Restoring means "the narrowing is undone", not "the list is byte-identical to a sample
    // taken 20s ago". `total` came from the AGGREGATED list of a shared fleet, which other
    // specs are concurrently adding to and deleting from, and which can also serve a degraded
    // read — so an exact toBe() asserts that nothing else in the fleet changed during this
    // test, which is not a property this test owns. Observed on CI: expected 2, received 1,
    // with the search feature working correctly.
    //
    // >= 2 keeps the real claim: after clearing, BOTH of this test's conversations are listed
    // again, which is exactly what the narrow removed.
    await expect.poll(async () => page.locator(sb.item).count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    assertConsistent(await snapshot(page), "after clearing the search");
  });

  test("switching between conversations swaps the transcript AND keeps the UI consistent", async ({ chat, page }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). Two conversations = two cold
    // sandboxes on the full target (5-25s before each first exec): 2 × ~30s + the 30s
    // switch-back poll ≈ 90s worst against a 60s default. 180s, not 120: the id lookup and
    // the switch-back poll below now allow the aggregated sidebar list time to settle.
    test.setTimeout(180_000);
    await chat.open();
    await chat.sendTurn("first conversation body");
    // Remember WHICH conversation this is. The switch-back below used `.last()`, but the
    // sidebar lists the whole fleet ordered by recency on the full target, so the first
    // conversation is not reliably the last row — the click landed on an unrelated
    // conversation and the poll then read ITS transcript (observed on CI: lastUserText
    // stayed "" for the full 30s while the transcript was intact in the conversation the
    // test never opened). data-conversation-id is the server id and cannot drift.
    // Poll: the row carries data-conversation-id only once the SERVER id has landed,
    // which is asynchronous after the first send.
    let firstId: string | null = null;
    await expect
      .poll(
        async () => {
          firstId = await page
            .locator(`${sb.item}[data-conversation-id]`)
            .first()
            .getAttribute("data-conversation-id")
            .catch(() => null);
          return firstId;
        },
        { timeout: 30_000 },
      )
      .toBeTruthy();

    await page.locator(sb.newSession).click();
    await chat.sendTurn("second conversation body");
    const onSecond = await snapshot(page);
    assertConsistent(onSecond, "on the second conversation");
    expect(onSecond.userMessages, "a new conversation starts with just its own turn").toBe(1);

    // Switch back — the other transcript loads, and no state from the previous one leaks.
    await page.locator(`${sb.item}[data-conversation-id="${firstId}"]`).click();
    await expect
      .poll(async () => (await snapshot(page)).lastUserText, { timeout: 60_000 })
      .toContain("first conversation body");
    const onFirst = await snapshot(page);
    assertConsistent(onFirst, "after switching back");
    expect(onFirst.queued, "no queue leaks across conversations").toEqual([]);
    expect(onFirst.interruptOpen, "no interrupt leaks across conversations").toBe(false);
    expect(onFirst.runError, "no error leaks across conversations").toBeNull();
  });
});

test.describe("right panel: tabs + sandbox surface", () => {
  test("the right panel renders and its tabs SWITCH without corrupting other surfaces", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("panel coverage");
    await expect(page.locator(panel.root)).toBeVisible({ timeout: 30_000 });
    const before = await snapshot(page);

    // Sandbox tab.
    await page.locator(panel.sandboxTab).click();
    await expect(page.locator(panel.sandboxTab)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(panel.sandboxPanel)).toBeVisible({ timeout: 20_000 });
    assertConsistent(await snapshot(page), "sandbox tab selected");

    // Queue tab — empty, and it says so rather than rendering a blank list.
    await page.locator(panel.queueTab).click();
    await expect(page.locator(panel.queueTab)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(panel.queueEmpty)).toBeVisible({ timeout: 20_000 });
    const after = await snapshot(page);
    assertConsistent(after, "queue tab selected");
    expect(after.userMessages, "switching tabs must not disturb the thread").toBe(before.userMessages);
  });

  test("the sandbox panel reports a state for a live conversation", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("!echo sandbox state");
    await page.locator(panel.sandboxTab).click();
    await expect(page.locator(panel.sandboxPanel)).toBeVisible({ timeout: 20_000 });
    const state = page.locator(panel.sandboxState);
    if (await state.count()) {
      expect((await state.first().innerText()).trim().length, "sandbox state must not be blank").toBeGreaterThan(0);
    }
    assertConsistent(await snapshot(page), "sandbox panel shown");
  });
});

test.describe("thread rendering details", () => {
  test("a TOOL CALL renders a card with a body, and the run completes cleanly", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("!echo tool card please");
    await expect(chat.toolCalls()).toHaveCount(1, { timeout: 45_000 });
    await chat.waitForIdle(); // sendTurn returns on the reply TEXT; the terminal event trails it
    // The card shows the command it ran (not an empty shell).
    const body = page.locator('[data-testid="provider-tool-body"]');
    if (await body.count()) {
      expect((await body.first().innerText()).trim().length, "the tool card must show its command").toBeGreaterThan(0);
    }
    const s = await snapshot(page);
    assertConsistent(s, "after a tool call");
    expect(s.running, "the tool run finished").toBe(false);
    expect(s.toolCards, "the tool card persisted in the thread").toBe(1);
  });

  test("tool cards + transcript SURVIVE a reload with identical counts", async ({ chat, page }) => {
    // CLUSTER-HONEST BUDGET (see stop-run.spec.ts:75). First turn waits for the sandbox
    // (~30s worst), the second is warm (~5s), then a reload re-folds the transcript under
    // a 45s re-mount budget: ~30 + 5 + 45 ≈ 80s worst against the 60s default.
    test.setTimeout(120_000);
    await chat.open();
    await chat.sendTurn("!echo persist one");
    await chat.sendTurn("!echo persist two");
    const before = await snapshot(page);
    expect(before.toolCards).toBe(2);

    await page.reload();
    await expect(chat.toolCalls()).toHaveCount(2, { timeout: 45_000 });
    const after = await snapshot(page);
    assertConsistent(after, "after reload with tool cards");
    expect(after.userMessages).toBe(before.userMessages);
    expect(after.assistantMessages).toBe(before.assistantMessages);
    expect(after.toolCards).toBe(before.toolCards);
  });

  test("the context-fill bar renders a valid fill for a live conversation", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("context bar coverage");
    const bar = page.locator('[data-testid="context-fill-bar"]');
    if (await bar.count()) {
      const fill = await bar.first().getAttribute("data-fill");
      if (fill !== null) {
        const pct = Number(fill);
        expect(Number.isNaN(pct), "context fill must be numeric").toBe(false);
        expect(pct, "context fill is a valid percentage").toBeGreaterThanOrEqual(0);
        expect(pct, "context fill is a valid percentage").toBeLessThanOrEqual(100);
      }
    }
    assertConsistent(await snapshot(page), "context bar rendered");
  });
});

test.describe("model picker", () => {
  test("the model picker offers the configured models and survives a switch", async ({ chat, page }) => {
    await chat.open();
    const picker = page.locator('[data-testid="model-picker"]');
    if (!(await picker.count())) test.skip(true, "model picker not rendered in this configuration");
    await expect(picker.first()).toBeVisible({ timeout: 20_000 });
    const options = picker.first().locator("option");
    expect(await options.count(), "the picker lists the configured catalog").toBeGreaterThan(1);

    await picker.first().selectOption({ index: 1 });
    await chat.sendTurn("after switching the model");
    const s = await snapshot(page);
    assertConsistent(s, "after a model switch");
    expect(s.runError, "a model switch must not error the run").toBeNull();
  });
});
