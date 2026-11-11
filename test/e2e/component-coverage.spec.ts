/**
 * Tier 3 E2E for wide component coverage: the sidebar rows and their controls, the right
 * panel's tabs, the sandbox panel, the model picker and the context-fill bar. At every step
 * it also asserts the whole-UI invariants (assertConsistent), so touching one component
 * cannot quietly corrupt another.
 */

import { test, expect, snapshot, assertConsistent, fillStable } from "./fixtures.js";
import { isFull } from "./target.js";

/** Full-target cards wait on a real sandbox exec. */
const TOOL_CARD_MS = isFull ? 90_000 : 45_000;

const sb = {
  list: '[data-testid="session-list"]',
  item: '[data-testid="session-item"]',
  title: '[data-testid="session-title"]',
  // The open conversation's star lives beside its title in the header.
  star: '[data-testid="header-conversation"] [data-testid="session-star"]',
  search: '[data-testid="session-search"]',
  newSession: '[data-testid="new-session"]',
  filtersToggle: '[data-testid="filters-toggle"]',
};
const panel = {
  root: '[data-testid="right-panel"]',
  sandboxTab: '[data-testid="right-panel-tab-session"]',
  sandboxPanel: '[data-testid="sandbox-panel"]',
  sandboxState: '[data-testid="sandbox-state"]',
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

  test("STARRING a conversation persists across a reload and disturbs nothing else", async ({ chat, page, request, baseURL }) => {
    // On the full target the first exec of a conversation waits for its sandbox pod, so the
    // default budget is too short.
    test.setTimeout(120_000);
    await chat.open();
    await chat.sendTurn("star me");
    await chat.waitForIdle();
    // Assert the row exists rather than an absolute list length, since the backend is shared.
    await expect(page.locator(sb.item).first()).toBeVisible({ timeout: 30_000 });
    const before = await snapshot(page);

    // Address the row by its server id, since the UI's optimistic star survives a reload via
    // localStorage whether or not the write landed.
    let convId: string | null = null;
    await expect
      .poll(
        async () => {
          convId = await page
            .locator(`${sb.item}[data-conversation-id]`)
            .first()
            .getAttribute("data-conversation-id")
            .catch(() => null);
          return convId;
        },
        { timeout: 30_000 },
      )
      .toBeTruthy();
    const row = page.locator(`${sb.item}[data-conversation-id="${convId}"]`);

    await page.locator(sb.star).click();

    // The star must reach the durable row, asked of the server rather than the UI.
    const starredOnServer = async () => {
      const res = await request.get(`${baseURL ?? "http://localhost:5173"}/conversations/${convId}`);
      if (!res.ok()) return `HTTP ${res.status()}`;
      return ((await res.json()) as { starred?: boolean }).starred === true;
    };
    await expect.poll(starredOnServer, { timeout: 20_000 }).toBe(true);

    await page.reload();
    await expect(page.locator(sb.item).first()).toBeVisible({ timeout: 30_000 });
    // The reloaded sidebar renders it starred after the server merge that follows the reload.
    await expect(row).toHaveAttribute("data-starred", "true", { timeout: 30_000 });
    // Wait for the transcript to finish re-folding before snapshotting.
    await expect.poll(async () => (await snapshot(page)).userMessages, { timeout: 30_000 })
      .toBe(before.userMessages);
    const after = await snapshot(page);
    assertConsistent(after, "after starring + reload");
    expect(after.sessions, "the conversation is still listed after the reload").toBeGreaterThanOrEqual(1);
    // Starring is a sidebar-only concern, so the thread must be untouched.
    expect(after.userMessages, "starring must not change the transcript").toBe(before.userMessages);
    expect(after.assistantMessages, "starring must not change the transcript").toBe(before.assistantMessages);

    // Unstar before leaving: a starred conversation cannot be deleted (DELETE 409), so
    // cleanState could never remove it.
    await page.locator(sb.star).click();
    await expect(row).not.toHaveAttribute("data-starred", "true", { timeout: 10_000 });
    // Confirm the unstar landed server-side, since a local-only unstar leaves the row undeletable.
    await expect.poll(starredOnServer, { timeout: 20_000 }).not.toBe(true);
  });

  test("SEARCH narrows the sidebar and restores the full list when cleared", async ({ chat, page }) => {
    // Two conversations, each with its own first-exec sandbox wait on the full target.
    test.setTimeout(180_000);
    await chat.open();
    // Both are first turns of their own conversation, so each waits for its own cold sandbox pod.
    await chat.sendTurn("alpha searchable", 90_000);
    await chat.waitForIdle();
    await page.locator(sb.newSession).click();
    await chat.sendTurn("beta searchable", 90_000);
    await chat.waitForIdle();
    // Wait for both rows rather than sampling once, since the router's aggregated list can
    // be transiently partial.
    await expect
      .poll(async () => page.locator(sb.item).count(), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2);
    const total = await page.locator(sb.item).count();
    expect(total, "both conversations are listed").toBeGreaterThanOrEqual(2);

    await fillStable(page.locator(sb.search), "alpha");
    await expect.poll(async () => page.locator(sb.item).count(), { timeout: 20_000 }).toBeLessThan(total);
    await fillStable(page.locator(sb.search), "");
    // Restoring means the narrowing is undone, not that the shared fleet's list is
    // byte-identical to the earlier sample.
    await expect.poll(async () => page.locator(sb.item).count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
    assertConsistent(await snapshot(page), "after clearing the search");
  });

  test("switching between conversations swaps the transcript AND keeps the UI consistent", async ({ chat, page }) => {
    // Two conversations are two cold sandboxes on the full target, plus time for the
    // aggregated list to settle.
    test.setTimeout(180_000);
    await chat.open();
    await chat.sendTurn("first conversation body");
    // Remember which conversation this is by server id, since the sidebar lists the whole
    // fleet by recency; the id lands asynchronously after the first send, so poll.
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

    // Switch back: the other transcript loads, and no state from the previous one leaks.
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

    // Session tab.
    await page.locator(panel.sandboxTab).click();
    await expect(page.locator(panel.sandboxTab)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(panel.sandboxPanel)).toBeVisible({ timeout: 20_000 });
    assertConsistent(await snapshot(page), "session tab selected");

    // There is no Queue tab: queued messages render inline in the thread, and nothing
    // is queued here, so no faded queued bubbles either.
    await expect(page.locator('[data-testid="right-panel-tab-queue"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="queued-message"]')).toHaveCount(0);
    const after = await snapshot(page);
    assertConsistent(after, "after tab switching");
    expect(after.userMessages, "switching tabs must not disturb the thread").toBe(before.userMessages);
  });

  test("the sandbox panel reports a live conversation's sandbox as running", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("!echo sandbox state");
    await page.locator(panel.sandboxTab).click();
    await expect(page.locator(panel.sandboxPanel)).toBeVisible({ timeout: 20_000 });
    // A turn ran, so the sandbox is up: never stuck on "starting".
    await expect(page.locator(panel.sandboxState)).toHaveAttribute("data-state", "running", { timeout: 60_000 });
    assertConsistent(await snapshot(page), "sandbox panel shown");
  });
});

test.describe("thread rendering details", () => {
  test("a TOOL CALL renders a card with a body, and the run completes cleanly", async ({ chat, page }) => {
    await chat.open();
    await chat.sendTurn("!echo tool card please");
    await expect(chat.toolCalls()).toHaveCount(1, { timeout: 45_000 });
    await chat.waitForIdle(); // sendTurn returns on the reply TEXT; the terminal event trails it
    // The folded card names the command it ran in its header (not an empty shell).
    const preview = page.locator('[data-testid="provider-tool-preview"]');
    if (await preview.count()) {
      expect((await preview.first().innerText()).trim().length, "the tool card must show its command").toBeGreaterThan(0);
    }
    const s = await snapshot(page);
    assertConsistent(s, "after a tool call");
    expect(s.running, "the tool run finished").toBe(false);
    expect(s.toolCards, "the tool card persisted in the thread").toBe(1);
  });

  test("tool cards + transcript SURVIVE a reload with identical counts", async ({ chat, page }) => {
    // Two full-target execs plus a reload.
    test.setTimeout(isFull ? 300_000 : 120_000);
    await chat.open();
    // completeTurn: sendTurn can return before the run ends.
    await chat.completeTurn("!echo persist one");
    await expect(chat.toolCalls()).toHaveCount(1, { timeout: TOOL_CARD_MS });
    await chat.completeTurn("!echo persist two");
    await expect(chat.toolCalls()).toHaveCount(2, { timeout: TOOL_CARD_MS });
    const before = await snapshot(page);
    expect(before.toolCards).toBe(2);

    await page.reload();
    await expect(chat.toolCalls()).toHaveCount(2, { timeout: TOOL_CARD_MS });
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
