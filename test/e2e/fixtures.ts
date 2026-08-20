/**
 * Shared e2e fixtures for the assistant-ui Thread.
 *
 * Provides:
 *   - real selectors for the assistant-ui DOM (aui-* classes / aria-labels)
 *   - a `chat` helper (send a message, wait for the assistant reply)
 *   - an AUTOMATIC "no error in the UI" assertion that runs after EVERY test
 *     (both the rendered error box and AG-UI/zod console errors). Tests never
 *     have to opt in — a surfaced error fails the test.
 *
 * The stack (agent-host fake mode + UI) is booted by playwright.config webServer.
 */

import { test as base, expect, type Page, type Locator, type APIRequestContext } from "@playwright/test";

export const sel = {
  errorBox: ".aui-message-error-root",
  userMessage: ".aui-user-message-content",
  assistantMessage: ".aui-assistant-message-content, .aui-md", // styled content
  // Count ONE node per tool call: the innermost rendered card — a provider card
  // (slack/github/…) or the generic fallback. NOT the .aui-tool-group-root
  // wrapper: groups now render EXPANDED (ToolGroupOpen), so the wrapper AND the
  // inner fallback are both mounted at once — counting both double-counts.
  toolCall: '.aui-tool-fallback-root, [data-testid="provider-tool-card"]',
  composerInput: '[aria-label="Message input"]',
};

export class Chat {
  constructor(private page: Page) {}

  async open() {
    await this.page.goto("/");
    await expect(this.input()).toBeVisible({ timeout: 20_000 });
  }

  input(): Locator {
    return this.page.locator(sel.composerInput).first();
  }

  async send(text: string) {
    // Wait until the composer is idle (no run in progress) — assistant-ui shows
    // a Send button when idle and a Cancel/Stop button while running. Sending
    // mid-run is dropped, so block until Send is available.
    await this.page
      .getByRole("button", { name: /send/i })
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .catch(() => {});
    const input = this.input();
    await input.click();
    await input.fill(text);
    await input.press("Enter");
  }

  userMessages(): Locator {
    return this.page.locator(sel.userMessage);
  }
  assistantMessages(): Locator {
    return this.page.locator(sel.assistantMessage);
  }
  toolCalls(): Locator {
    return this.page.locator(sel.toolCall);
  }
  /** The scrolling thread viewport (assistant-ui ThreadPrimitive.Viewport). */
  viewport(): Locator {
    return this.page.locator('[data-slot="aui_thread-viewport"]').first();
  }

  /** How far the viewport is from the bottom, in px (0 == pinned to bottom). */
  async distanceFromBottom(): Promise<number> {
    return this.viewport().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  }

  /** How much the viewport CAN scroll (scrollHeight - clientHeight). 0 == the thread
   *  fits with nothing to scroll — a scroll-lock assertion would be vacuous. */
  async scrollableHeight(): Promise<number> {
    return this.viewport().evaluate((el) => el.scrollHeight - el.clientHeight);
  }

  /** Deterministically settle the viewport at the bottom before asserting the
   *  at-bottom state. assistant-ui's `isAtBottom` flag (which drives the arrow's
   *  disabled state) updates from a SCROLL EVENT — after auto-scroll settles there
   *  may be no further scroll event to fire, so the flag can trail the real position
   *  (the CI-only "arrow still enabled at the bottom" flake). An explicit
   *  scrollTo(bottom) forces a scroll event → the store recomputes; then poll the
   *  measured distance to confirm we're actually pinned. */
  async settleAtBottom(px = 40): Promise<void> {
    await this.viewport().evaluate((el) =>
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" as ScrollBehavior }),
    );
    await expect.poll(() => this.distanceFromBottom(), { timeout: 10_000 }).toBeLessThanOrEqual(px);
  }

  /** The scroll-to-bottom arrow. assistant-ui's ScrollToBottom primitive DISABLES it
   *  (CSS `disabled:invisible`) while pinned to the bottom and ENABLES it once the
   *  user scrolls up — so its enabled/visible state is the authoritative "the lock
   *  released" signal (more robust than a pixel threshold). */
  scrollToBottomButton(): Locator {
    return this.page.locator(".aui-thread-scroll-to-bottom").first();
  }

  /** Wait for an assistant reply containing `re` (default: any non-empty).
   *  Generous timeout: a freshly-created conversation lazily spawns its bridge
   *  on the first prompt, so the very first reply can be slower than later ones.
   *
   *  NOTE for MULTI-TURN loops: this matches the FIRST occurrence of `re`, which
   *  a PRIOR turn's identical reply already satisfies (the fake agent says the same
   *  thing every turn) — so it returns immediately and the next send can race an
   *  unfinished run, dropping a turn. Use `sendTurn` (count-based) for >1 turn. */
  async waitForReply(re: RegExp = /\S/, timeout = 45_000) {
    await expect(this.page.getByText(re).first()).toBeVisible({ timeout });
  }

  /** Send one turn and wait until THIS turn's assistant reply has landed — by
   *  waiting for the assistant-message count to grow past the pre-send baseline,
   *  not for matching text (which a prior identical reply already satisfies). This
   *  is the race-free primitive for multi-turn conversations: it guarantees the run
   *  finished (a new assistant message exists) before returning, so the next send
   *  can't be dropped mid-run. */
  async sendTurn(text: string, timeout = 45_000) {
    const before = await this.assistantMessages().count();
    await this.send(text);
    await expect
      .poll(async () => this.assistantMessages().count(), { timeout })
      .toBeGreaterThan(before);
  }

  /** Send a message WITHOUT waiting for the idle Send button — for queueing behind an in-flight run
   *  (the composer accepts input mid-run; the message becomes a QUEUED item). `send()` deliberately
   *  waits for Send to be visible (idle), which would block here; this fills + submits immediately. */
  async sendWhileRunning(text: string) {
    const input = this.input();
    await input.click();
    await input.fill(text);
    await input.press("Enter");
  }

  /** Start a long in-flight run (the fake agent runs a real `sleep <sec>` in the sandbox) and wait
   *  until the UI shows the working state — so a subsequent sendWhileRunning() genuinely queues. */
  async startLongRun(sec = 20) {
    await this.send(`!sleep ${sec}`);
    await expect(this.page.locator('[data-testid="run-status-bar"]')).toBeVisible({ timeout: 30_000 });
  }

  /** The durable queued-message rows (QUEUE_UPDATED-driven + optimistic). */
  queuedMessages(): Locator {
    return this.page.locator('[data-testid="queued-message"]');
  }
  /** Wait until the run is genuinely OVER — not merely until the reply text appeared. `sendTurn`
   *  returns when the assistant MESSAGE lands, but the run's terminal event trails it slightly, so a
   *  "must be idle now" assertion made right after sendTurn races a still-finishing run. Poll the
   *  run-status bar (the authoritative in-flight signal) instead. */
  async waitForIdle(timeout = 45_000) {
    await expect(this.page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout });
  }

  /** Open the right panel's Queue tab (so queued rows are visible to assert on). */
  async openQueueTab() {
    const tab = this.page.locator('[data-testid="right-panel-tab-queue"]');
    if (await tab.isVisible().catch(() => false)) await tab.click();
  }
}

type Fixtures = {
  chat: Chat;
  /** Accumulates console errors for the no-error assertion. */
  consoleErrors: string[];
  /** Auto: wipes server + client conversation state before each test so the
   *  shared (single-process) webServer doesn't leak conversations between tests
   *  and break absolute-count assertions. */
  cleanState: void;
};

export const test = base.extend<Fixtures>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await use(errors);
  },

  // Runs automatically (auto: true) before every test: the e2e webServer is one
  // long-lived agent-host process whose conversation list is persisted + hydrated,
  // so without a reset each test would see the previous tests' conversations.
  cleanState: [
    async ({ request, context, baseURL }, use) => {
      const base = baseURL ?? "http://localhost:5173";
      // 1. Server: delete every known conversation, then POLL until the list is
      //    actually empty. The delete + sandbox-destroy is async server-side, so
      //    proceeding immediately races the next test's first /conversations
      //    fetch (which would merge leftovers in). Poll to a true clean slate.
      for (let i = 0; i < 50; i++) {
        const res = await request.get(`${base}/conversations`);
        if (!res.ok()) break;
        const convs = (await res.json()) as Array<{ id: string }>;
        if (convs.length === 0) break;
        await Promise.all(convs.map((c) => request.delete(`${base}/conversations/${c.id}`)));
        await new Promise((r) => setTimeout(r, 100));
      }
      // Let the server settle after the destroys (bridge stop + sandbox teardown)
      // so the next test's first prompt starts a clean, unstalled conversation.
      await new Promise((r) => setTimeout(r, 300));
      // 2. Client: clear persisted sessions on the origin. The server is empty
      //    now (polled above), so loading the app to establish the origin can't
      //    re-merge anything. Use a throwaway page, then close it and give its
      //    AG-UI/SSE connection a beat to tear down so it doesn't race the next
      //    test's first prompt against the shared single-process agent-host.
      const blank = await context.newPage();
      await blank.goto(base);
      await blank.evaluate(() => {
        try {
          window.localStorage.clear();
          window.sessionStorage.clear();
        } catch {
          /* storage unavailable — non-fatal */
        }
      });
      await blank.close();
      await new Promise((r) => setTimeout(r, 300));
      await use();
    },
    { auto: true },
  ],

  chat: async ({ page }, use) => {
    await use(new Chat(page));
  },
});

/**
 * After every test: assert the UI surfaced no error. Runs automatically for all
 * specs that import `test` from this file.
 */
test.afterEach(async ({ page, consoleErrors }) => {
  // 1. No rendered error box.
  const boxes = page.locator(sel.errorBox);
  const count = await boxes.count();
  if (count > 0) {
    const txt = (await boxes.allTextContents()).join("\n");
    throw new Error(`UI surfaced ${count} error box(es):\n${txt}`);
  }

  // 2. No raw validation/JSON error text leaked into the page.
  const leaked = await page
    .locator('text=/invalid_type|"code":\\s*"|zod|Required/i')
    .allTextContents();
  if (leaked.length) {
    throw new Error(`UI leaked validation error text:\n${leaked.join("\n")}`);
  }

  // 3. No AG-UI/schema/agent errors in the console.
  const aguiErrors = consoleErrors.filter((e) =>
    /invalid_type|threadId|Required|zod|AG-?UI|Agent execution failed|still active|Cannot send/i.test(e),
  );
  if (aguiErrors.length) {
    throw new Error(`AG-UI console errors:\n${aguiErrors.join("\n")}`);
  }
});

export { expect };

/**
 * A WHOLE-UI STATE SNAPSHOT — every surface that can independently go wrong, read in ONE pass.
 *
 * Why this exists: asserting one fact per test (does the queue row exist?) misses the failure mode
 * that actually bites — CROSS-COMPONENT DIVERGENCE, where the thread says one thing, the queue
 * another, the run-status bar a third, and the sidebar a fourth, all at the same instant. A
 * single-fact test passes straight through that. Snapshotting every surface and asserting
 * INVARIANTS BETWEEN them is what turns "the UI is unreliable" into a specific failing assertion.
 */
export interface UiSnapshot {
  // thread
  userMessages: number;
  assistantMessages: number;
  toolCards: number;
  lastUserText: string;
  // run state
  running: boolean;          // the thinking indicator / run-status bar is up
  composerSendable: boolean; // the Send button is offered (idle) — NOT the Stop button
  composerStop: boolean;
  runError: string | null;
  authError: boolean;
  // queue
  queued: string[];          // queued row texts, in render order
  queueBadge: string | null;
  // approvals
  interruptOpen: boolean;
  interruptOptions: number;
  approvalsBadge: string | null;
  // sidebar / session
  sessions: number;
  activeTitle: string | null;
  // right panel
  panelVisible: boolean;
  selectedTab: string | null;
}

/** Read every UI surface at one instant. Never throws — a missing element is a null/0/false, so a
 *  snapshot is always comparable (that's the point: absence IS state). */
export async function snapshot(page: Page): Promise<UiSnapshot> {
  const count = (s: string) => page.locator(s).count();
  const visible = (s: string) => page.locator(s).first().isVisible().catch(() => false);
  const text = async (s: string): Promise<string | null> => {
    const l = page.locator(s).first();
    return (await l.count()) ? ((await l.innerText().catch(() => "")) || "").trim() : null;
  };
  const users = page.locator(sel.userMessage);
  const nUsers = await users.count();
  const selectedTab = await page
    .locator('[data-testid^="right-panel-tab-"][aria-selected="true"]')
    .first()
    .getAttribute("data-testid")
    .catch(() => null);
  return {
    userMessages: nUsers,
    assistantMessages: await page.locator(sel.assistantMessage).count(),
    toolCards: await count(sel.toolCall),
    lastUserText: nUsers ? ((await users.nth(nUsers - 1).innerText().catch(() => "")) || "").trim() : "",
    running: await visible('[data-testid="run-status-bar"]'),
    composerSendable: await page.getByRole("button", { name: /send/i }).first().isVisible().catch(() => false),
    composerStop: await visible('[data-testid="composer-stop"]'),
    runError: await text('[data-testid="run-error-message"]'),
    authError: await visible('[data-testid="stream-auth-error-bar"]'),
    queued: await page.locator('[data-testid="queued-message-text"]').allInnerTexts()
      .then((t) => t.map((s) => s.trim())).catch(() => []),
    queueBadge: await text('[data-testid="right-panel-badge-queue"]'),
    interruptOpen: await visible('[data-testid="interrupt-panel"]'),
    interruptOptions: await count('[data-testid="interrupt-option"]'),
    approvalsBadge: await text('[data-testid="right-panel-badge-approvals"]'),
    sessions: await count('[data-testid="session-item"]'),
    activeTitle: await text('[data-testid="session-title"]'),
    panelVisible: await visible('[data-testid="right-panel"]'),
    selectedTab,
  };
}

/** The CROSS-COMPONENT INVARIANTS that must hold at EVERY instant, whatever the app is doing.
 *  A violation here is exactly the "weird detached state" the user reports — two components
 *  disagreeing about the same reality. Call it after every step of every test. */
export function assertConsistent(s: UiSnapshot, when: string) {
  // Send and Stop are the SAME control in two states — never both, never neither.
  expect(s.composerSendable && s.composerStop, `${when}: composer shows BOTH Send and Stop`).toBe(false);
  // The run indicator and the composer must agree on whether a run is in flight.
  if (s.running) {
    expect(s.composerSendable, `${when}: run-status says RUNNING but the composer offers Send`).toBe(false);
  } else {
    expect(s.composerStop, `${when}: no run in flight but the composer still shows Stop`).toBe(false);
  }
  // A terminal error and an in-flight run are mutually exclusive states.
  if (s.runError) {
    expect(s.running, `${when}: showing a terminal run error WHILE claiming to run`).toBe(false);
  }
  // Badges must match the rows they count (a stale badge is the classic divergence) — but ONLY when
  // the Queue tab is actually SELECTED. The badge is always visible; the rows only mount when that
  // tab is open, so comparing them on any other tab compares a real count against an unmounted list.
  if (s.queueBadge && s.selectedTab === "right-panel-tab-queue") {
    expect(Number(s.queueBadge.replace(/\D/g, "")), `${when}: queue badge != queued rows`).toBe(s.queued.length);
  }
  // An interrupt panel with no options is un-answerable — a dead-end state.
  if (s.interruptOpen) {
    expect(s.interruptOptions, `${when}: interrupt panel open with NO options (un-answerable)`).toBeGreaterThan(0);
  }
  // Every queued row must carry text; a blank row means the queue rendered without its content.
  for (const q of s.queued) {
    expect(q.length, `${when}: a queued row rendered EMPTY`).toBeGreaterThan(0);
  }
}

/** Cross-check the DOM against the SERVER's own view — the only way to catch a UI that has silently
 *  detached from reality (renders fine, but no longer reflects what the agent-host actually has). */
export async function assertMatchesServer(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
  when: string,
) {
  const base = baseURL ?? "http://localhost:5173";
  const res = await request.get(`${base}/conversations`);
  if (!res.ok()) return; // server not reachable for this stack — skip rather than fail spuriously
  const convs = (await res.json()) as Array<{ id: string }>;
  const s = await snapshot(page);
  // The sidebar must list exactly the conversations the server knows about.
  expect(s.sessions, `${when}: sidebar shows ${s.sessions} sessions, server has ${convs.length}`)
    .toBe(convs.length);
}
