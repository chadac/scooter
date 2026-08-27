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
    // VERIFY the send actually landed. Against the fake agent the composer is instantly ready, so a
    // fill+Enter always took. Against a REAL model the send button can still be disabled (or the
    // editor not yet mounted) and the keystroke is silently DROPPED — the input keeps the text and
    // the turn never happens, which reads downstream as "the model never replied". Retry until the
    // composer is empty (submitted) rather than assuming.
    for (let i = 0; i < 20; i++) {
      const left = await input.inputValue().catch(() => "");
      if (left.trim() === "") return; // submitted
      await this.page.waitForTimeout(500);
      await input.click().catch(() => {});
      await input.press("Enter").catch(() => {});
    }
    throw new Error(`composer never accepted the message (still holding text): ${text.slice(0, 60)}`);
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

  /** Send a turn and wait for it to COMPLETE (reply landed AND the run ended), tolerating a hostile
   *  stream. Unlike `sendTurn`, this waits on the assistant-message COUNT and then on genuine idle —
   *  and unlike `waitForIdle` alone it can't return early just because the run hasn't started yet
   *  (which made corruption tests "pass through" in ~1.7s having done nothing). */
  async completeTurn(text: string, timeout = 60_000) {
    const before = await this.assistantMessages().count();
    await this.send(text);
    // The run must actually BEGIN before we can meaningfully wait for it to end.
    await expect(this.page.locator('[data-testid="run-status-bar"]'))
      .toBeVisible({ timeout: 30_000 })
      .catch(() => {}); // a very fast turn may finish before we look — the count poll below covers it
    await expect
      .poll(async () => this.assistantMessages().count(), { timeout })
      .toBeGreaterThan(before);
    await this.waitForIdle(timeout);
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
  /** Auto: forwards browser telemetry spans to the test output (E2E_TELEMETRY=1). */
  telemetryForwarding: void;
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

  // Forward telemetry spans to the test output when E2E_TELEMETRY=1, so a failing spec
  // shows the same conversation lifecycle the deployed traces do.
  //
  // auto:true is LOAD-BEARING. Playwright fixtures are LAZY — one instantiates only if a
  // test destructures it. Hanging this off `consoleErrors` meant it never attached for the
  // specs that do not request that fixture (stop-run among them), so the browser emitted
  // the spans and nothing was listening.
  telemetryForwarding: [
    async ({ page }, use) => {
      if (process.env.E2E_TELEMETRY === "1") {
        page.on("console", (m) => {
          if (m.text().startsWith("scooter.span")) {
            // eslint-disable-next-line no-console
            console.log(`  [browser] ${m.text()}`);
          }
        });
      }
      await use();
    },
    { auto: true },
  ],

  // Runs automatically (auto: true) before every test: the e2e webServer is one
  // long-lived agent-host process whose conversation list is persisted + hydrated,
  // so without a reset each test would see the previous tests' conversations.
  cleanState: [
    async ({ request, context, baseURL }, use) => {
      const base = baseURL ?? "http://localhost:5173";
      // SAFETY (belt-and-braces). This fixture deletes EVERY conversation to give the shared local
      // fake stack a clean slate. Run against a LIVE deployment that destroys real user data — which
      // is exactly what happened once against odin before this guard existed.
      //
      // TWO independent gates, because one flag proved insufficient (the flag was added AFTER a run
      // had already been launched without it):
      //   1. RUN_LIVE_E2E=1 — the explicit "this is a live target" opt-out.
      //   2. baseURL is not localhost — a structural check that cannot be forgotten. Any non-local
      //      target hard-FAILS rather than silently skipping, so a spec that genuinely needs a wipe
      //      can never quietly run it against a real deployment.
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
      if (process.env.RUN_LIVE_E2E === "1") {
        await use(); // live target: create-your-own-conversations specs need no wipe at all
        return;
      }
      if (!isLocal) {
        throw new Error(
          `REFUSING to wipe conversations on a non-local target (${base}). The cleanState fixture ` +
            `deletes EVERY conversation and must never touch a live deployment. Set RUN_LIVE_E2E=1 ` +
            `for live runs (which skips the wipe entirely).`,
        );
      }
      // 1. Server: delete every known conversation, then POLL until the list is
      //    actually empty. The delete + sandbox-destroy is async server-side, so
      //    proceeding immediately races the next test's first /conversations
      //    fetch (which would merge leftovers in). Poll to a true clean slate.
      for (let i = 0; i < 50; i++) {
        const res = await request.get(`${base}/conversations`);
        if (!res.ok()) {
          // FAST: the single-process server is down — nothing to wipe, tests will say so.
          if (process.env.E2E_TARGET !== "full") break;
          // FULL: the router 502s the list when every upstream momentarily fails to answer
          // (its all-upstreams-failed guard). Skipping the wipe on that transient hands the
          // next test a dirty fleet — retry instead of silently doing nothing.
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const convs = (await res.json()) as Array<{ id: string; starred?: boolean }>;
        if (convs.length === 0) {
          // FAST: one empty read is authoritative — a single agent-host process.
          if (process.env.E2E_TARGET !== "full") break;
          // FULL (multi-replica): an empty read is NOT proof of a clean slate. The router's
          // GET /conversations fans out to the READY agent-host pods and degrades to a partial
          // list when a pod is missing/slow — so a pod that briefly drops out of the endpoints
          // takes its rows with it, and "empty" can mean "the pod still holding rows wasn't
          // asked". Observed on CI: cleanState deleted 5 leftovers (all 204), read [], and 3 of
          // them resurfaced 20s later from a pod the aggregate had skipped — failing the first
          // spec on absolute row counts. Require the emptiness to be STABLE (3 consecutive
          // empty reads, 1s apart) and go back to deleting if anything resurfaces.
          let stable = true;
          for (let k = 0; k < 3; k++) {
            await new Promise((r) => setTimeout(r, 1000));
            const again = await request.get(`${base}/conversations`);
            if (!again.ok()) continue; // transient read error — don't count it as dirty
            const rows = (await again.json()) as Array<{ id: string }>;
            if (rows.length > 0) {
              stable = false;
              break;
            }
          }
          if (stable) break;
          continue; // rows resurfaced — loop back into the delete pass
        }
        await Promise.all(
          convs.map(async (c) => {
            // UNSTAR FIRST. DELETE returns 409 on a starred conversation ("unstar before
            // deleting"), so a test that stars one and then fails before unstarring leaves a row
            // this loop can NEVER remove: it spins 50 times, gives up, and every later test
            // inherits the leftover — which is exactly how sessions.spec.ts came to fail 8/10
            // with "Expected 1, Received 2" and titles bleeding across tests.
            // FULL: unstar UNCONDITIONALLY. `starred` comes from the aggregated list, which on a
            // multi-replica fleet can omit or stale the flag for a row served by a pod that was
            // briefly skipped — so trusting it means a genuinely starred conversation gets a bare
            // DELETE, 409s, and survives every one of the 50 attempts. Observed on CI: one
            // conversation held the whole shard hostage for 3 minutes and failed 6 later specs.
            // The PATCH is idempotent and cheap, so guessing wrong costs nothing.
            if (c.starred || process.env.E2E_TARGET === "full") {
              await request
                .patch(`${base}/conversations/${c.id}/starred`, { data: { starred: false } })
                .catch(() => undefined);
            }
            const del = await request.delete(`${base}/conversations/${c.id}`);
            // A 409 means it was still starred when the DELETE landed (the unstar raced, or the
            // flag arrived late). Unstar again and retry once — otherwise this row is immortal.
            if (del.status() === 409) {
              await request
                .patch(`${base}/conversations/${c.id}/starred`, { data: { starred: false } })
                .catch(() => undefined);
              return request.delete(`${base}/conversations/${c.id}`);
            }
            return del;
          }),
        );
        // FULL: 1s, not 100ms, between delete passes. A conversation's destroy is async
        // server-side (bridge stop + sandbox teardown), and a SUSPENDED one must first be
        // hydrated back into memory before it can be ended — so it can still be listed for
        // several seconds after a 204. At 100ms the 50 attempts burn out in ~5s, which is
        // exactly what CI showed: four specs each failing in 6.2-6.6s naming the same
        // conversation, one the previous test had suspended. 1s gives the loop ~50s, past
        // the observed teardown. Fast keeps 100ms — its destroy is in-process and immediate.
        await new Promise((r) => setTimeout(r, process.env.E2E_TARGET === "full" ? 1000 : 100));
        // FAIL LOUD on the last iteration rather than shrugging. This loop used to exhaust its 50
        // attempts and continue silently, so an UNDELETABLE conversation (e.g. a starred one —
        // DELETE 409s) leaked into every later test and surfaced as unrelated assertion failures
        // ("Expected 1, Received 2", titles from another test) with no hint of the real cause.
        // A fixture that cannot establish its precondition must say so, not hand the next test a
        // dirty slate.
        if (i === 49) {
          const left = (await (await request.get(`${base}/conversations`)).json()) as Array<{
            id: string;
            starred?: boolean;
            title?: string;
          }>;
          if (left.length) {
            throw new Error(
              `cleanState could not empty the server after 50 attempts. Still present: ` +
                left.map((c) => `${c.id}${c.starred ? " (STARRED — DELETE 409s)" : ""}`).join(", ") +
                `. State persists at LOCAL_STATE_PATH (default /tmp/agent-host-e2e), so this survives ` +
                `restarts until that directory is cleared.`,
            );
          }
        }
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
  /** Whether the CHAT view is mounted at all (composer present). False on the settings page, where
   *  the chat-view invariants do not apply. */
  chatMounted: boolean;
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
  return {
    chatMounted: await visible(sel.composerInput),
    userMessages: nUsers,
    assistantMessages: await page.locator(sel.assistantMessage).count(),
    toolCards: await count(sel.toolCall),
    lastUserText: nUsers ? ((await users.nth(nUsers - 1).innerText().catch(() => "")) || "").trim() : "",
    running: await visible('[data-testid="run-status-bar"]'),
    // Target the COMPOSER's send button precisely (.aui-composer-send / aria-label "Send message").
    // A loose getByRole(/send/i) also matches SIDEBAR row buttons named after the conversation title
    // (e.g. "Delete baseline before simultaneous sends"), which produced a false "composer shows BOTH
    // Send and Stop" whenever a message contained the word "send".
    composerSendable: await visible('.aui-composer-send, [aria-label="Send message"]'),
    composerStop: await visible('[data-testid="composer-stop"]'),
    runError: await text('[data-testid="run-error-message"]'),
    authError: await visible('[data-testid="stream-auth-error-bar"]'),
    // ATOMIC TRIPLE (same reasoning as the interrupt pair above). assertConsistent cross-checks
    // queueBadge against queued.length *and* against selectedTab; read separately, a message
    // draining from the queue between the three queries yields a badge/rows mismatch that never
    // existed on screen. One evaluate keeps them mutually consistent.
    ...(await page.evaluate(() => {
      const txt = (sel: string) => document.querySelector(sel)?.textContent?.trim() || null;
      return {
        queued: Array.from(document.querySelectorAll('[data-testid="queued-message-text"]'))
          .map((e) => (e.textContent || "").trim()),
        queueBadge: txt('[data-testid="right-panel-badge-queue"]'),
        selectedTab:
          document
            .querySelector('[data-testid^="right-panel-tab-"][aria-selected="true"]')
            ?.getAttribute("data-testid") ?? null,
      };
    })),
    // ATOMIC PAIR. Read in ONE page.evaluate so the panel and its option count come from the SAME
    // DOM state. As two sequential queries they can straddle a React re-render: an approval that
    // resolves in between yields interruptOpen=true with interruptOptions=0 — a dead-end state the
    // user never actually saw, which then trips the "un-answerable panel" invariant. The component
    // itself cannot render empty (InterruptPanel returns null when nothing is pending), so any such
    // reading is an artifact of non-atomic sampling, not a real UI state.
    ...(await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="interrupt-panel"]');
      return {
        interruptOpen: !!panel,
        interruptOptions: document.querySelectorAll('[data-testid="interrupt-option"]').length,
      };
    })),
    approvalsBadge: await text('[data-testid="right-panel-badge-approvals"]'),
    sessions: await count('[data-testid="session-item"]'),
    activeTitle: await text('[data-testid="session-title"]'),
    panelVisible: await visible('[data-testid="right-panel"]'),
  };
}

/** The CROSS-COMPONENT INVARIANTS that must hold at EVERY instant, whatever the app is doing.
 *  A violation here is exactly the "weird detached state" the user reports — two components
 *  disagreeing about the same reality. Call it after every step of every test. */
export function assertConsistent(s: UiSnapshot, when: string) {
  // SCOPE: these are CHAT-VIEW invariants (composer Send/Stop, run status, queue badges). On a
  // non-chat view — e.g. the settings page — none of those components are mounted, so asserting
  // them is meaningless rather than merely redundant. Detect that and check only what applies.
  if (!s.chatMounted) return;
  // Send and Stop are the SAME control in two states — never both, never neither.
  expect(s.composerSendable && s.composerStop, `${when}: composer shows BOTH Send and Stop`).toBe(false);
  // NOTE: "running => composer must NOT offer Send" is NOT an invariant here, though it is the
  // obvious one to write. Scooter deliberately keeps the composer submittable DURING a run: a
  // message sent mid-run is QUEUED (server-side priority queue), which is why
  // useRepositoryRuntime passes isRunning=false to the external-store runtime unconditionally.
  // assistant-ui would otherwise swallow the keystroke and the message would never reach the queue
  // — the "messages sent while working don't show up" bug (#279). Asserting the opposite here
  // contradicts the product and is what failed CI on main (concurrency-divergence.spec.ts:128).
  // The real invariant is the one that still holds: an IDLE app must not present a Stop button.
  if (!s.running) {
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

  // Compare the actual IDS, not just counts — a matching count with different ids is exactly
  // the silent detachment this guards against.
  //
  // A conversation the user has started but not yet sent in ("+ New conversation") is
  // deliberately local-only: it is selected instantly, and the server assigns its real id on
  // the first prompt. Those rows mark themselves data-pending-create and are expected to be
  // absent server-side; every OTHER row must correspond to a real conversation.
  const rows = await page.locator('[data-testid="session-item"]').evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-conversation-id") ?? "",  // the SERVER id; absent while pending
      pending: el.getAttribute("data-pending-create") === "true",
    })),
  );
  const serverIds = new Set(convs.map((c) => c.id));
  const missing = rows.filter((r) => !r.pending && !serverIds.has(r.id)).map((r) => r.id);
  const notShown = convs.filter((c) => !rows.some((r) => r.id === c.id)).map((c) => c.id);

  expect(
    missing,
    `${when}: sidebar shows conversation(s) the server does not have: ${missing.join(", ")}`,
  ).toEqual([]);
  // FAST ONLY. "The sidebar shows everything the server has" holds on the single-process,
  // freshly-wiped stack, where the only conversations in existence are this test's. On the
  // full target the server is a shared multi-replica fleet: it legitimately holds rows from
  // OTHER specs running against the same backend, and the sidebar's default scope shows the
  // user's own conversations rather than the whole fleet — so this direction reports normal
  // cross-spec coexistence as a divergence (observed on CI: two unrelated conversation ids).
  // The `missing` direction above is the one that catches real detachment, and it stays on
  // for both targets: a row the server does not have is always a bug.
  if (process.env.E2E_TARGET !== "full") {
    expect(
      notShown,
      `${when}: server has conversation(s) the sidebar does not show: ${notShown.join(", ")}`,
    ).toEqual([]);
  }
  // At most one unsent "New chat" can be pending at a time — more means they are leaking.
  expect(
    rows.filter((r) => r.pending).length,
    `${when}: more than one uncreated conversation in the sidebar`,
  ).toBeLessThanOrEqual(1);
}

/** Where step screenshots land. One directory per test run; each shot is prefixed with a monotonic
 *  index so the sequence reads in order. */
const SHOT_DIR = process.env.UI_SHOT_DIR ?? "test-results/ui-timeline";
let shotSeq = 0;

/** Capture the UI at this instant, named for the step. Screenshots make a NONDETERMINISTIC failure
 *  interpretable: an invariant tells you two components disagreed, the image tells you what the user
 *  would actually have been looking at. Enabled by default for live runs (UI_SHOTS=1); a failure to
 *  capture must never fail the test. */
export async function shot(page: Page, when: string): Promise<void> {
  if (process.env.UI_SHOTS !== "1") return;
  const safe = when.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  const idx = String(++shotSeq).padStart(3, "0");
  await page
    .screenshot({ path: `${SHOT_DIR}/${idx}-${safe}.png`, fullPage: false })
    .catch(() => {}); /* never fail a test because a screenshot failed */
}

/** snapshot + assertConsistent + a screenshot, in one call — the standard "check everything at this
 *  step" primitive. Captures the shot BEFORE asserting, so a failing step still leaves an image of
 *  the exact state that failed. */
export async function checkpoint(page: Page, when: string): Promise<UiSnapshot> {
  const s = await snapshot(page);
  await shot(page, when);
  assertConsistent(s, when);
  return s;
}
