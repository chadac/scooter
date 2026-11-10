/**
 * Shared e2e fixtures for the assistant-ui Thread: real selectors for the assistant-ui
 * DOM, a `chat` helper that sends a message and waits for the reply, and an automatic
 * "no error in the UI" assertion (rendered error box and AG-UI/zod console errors) that
 * runs after every test. The stack (agent-host fake mode + UI) is booted by the
 * playwright.config webServer.
 */

import { test as base, expect, type Page, type Locator, type APIRequestContext } from "@playwright/test";
import { newApiRequestContext } from "./support/apiRequest.mjs";

export const sel = {
  errorBox: ".aui-message-error-root",
  userMessage: ".aui-user-message-content",
  assistantMessage: ".aui-assistant-message-content, .aui-md", // styled content
  // One node per tool call: the innermost rendered card, not the .aui-tool-group-root
  // wrapper that is mounted alongside it.
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
    // Wait until the composer is idle (Send button visible); a message sent mid-run is dropped.
    await this.page
      .getByRole("button", { name: /send/i })
      .first()
      .waitFor({ state: "visible", timeout: 30_000 })
      .catch(() => {});
    await this.submit(text);
  }

  /** Fill the composer and submit, verifying the message actually left it (an empty composer is the only proof the turn was accepted). */
  private async submit(text: string) {
    const input = this.input();
    await input.click();
    await input.fill(text);
    await input.press("Enter");
    // Poll rather than re-press every tick: an Enter on text already mid-submit sends it twice.
    for (let i = 0; i < 20; i++) {
      const left = await input.inputValue().catch(() => "");
      if (left.trim() === "") return;
      if (i > 0 && i % 4 === 0) {
        await input.click().catch(() => {});
        await input.press("Enter").catch(() => {});
      }
      await this.page.waitForTimeout(500);
    }
    throw new Error(`composer never accepted the message (still holding text): ${text.slice(0, 60)}`);
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

  /** How much the viewport can scroll; 0 means a scroll-lock assertion would be vacuous. */
  async scrollableHeight(): Promise<number> {
    return this.viewport().evaluate((el) => el.scrollHeight - el.clientHeight);
  }

  /** Settle the viewport at the bottom with an explicit scrollTo, so assistant-ui's
   *  scroll-event-driven `isAtBottom` flag recomputes before the at-bottom state is asserted. */
  async settleAtBottom(px = 40): Promise<void> {
    await this.viewport().evaluate((el) =>
      el.scrollTo({ top: el.scrollHeight, behavior: "instant" as ScrollBehavior }),
    );
    await expect.poll(() => this.distanceFromBottom(), { timeout: 10_000 }).toBeLessThanOrEqual(px);
  }

  /** The scroll-to-bottom arrow, which assistant-ui disables while pinned to the bottom
   *  and enables once the user scrolls up. */
  scrollToBottomButton(): Locator {
    return this.page.locator(".aui-thread-scroll-to-bottom").first();
  }

  /** Wait for an assistant reply containing `re`; this matches the first occurrence, which
   *  a prior identical reply already satisfies, so use `sendTurn` for multi-turn loops. */
  // Same budget as sendTurn/completeTurn: on the full target the reply waits out a cold
  // sandbox boot, which alone can outlast the fast target's whole budget.
  async waitForReply(re: RegExp = /\S/, timeout = process.env.E2E_TARGET === "full" ? 120_000 : 45_000) {
    await expect(this.page.getByText(re).first()).toBeVisible({ timeout });
  }

  /** Send one turn and wait for the assistant-message count to grow past the pre-send
   *  baseline, which proves this turn's run finished before the next send. */
  // On the full target a turn first waits for a ready sandbox pod, so it gets a longer budget.
  async sendTurn(text: string, timeout = process.env.E2E_TARGET === "full" ? 120_000 : 45_000) {
    const before = await this.assistantMessages().count();
    await this.send(text);
    await expect
      .poll(async () => this.assistantMessages().count(), { timeout })
      .toBeGreaterThan(before);
  }

  /** Fill and submit without waiting for the idle Send button, so the message queues behind an in-flight run. */
  async sendWhileRunning(text: string) {
    await this.submit(text);
  }

  /** Start a long in-flight run (the fake agent runs a real `sleep <sec>` in the sandbox) and
   *  wait until its sleep tool call is running, so a subsequent sendWhileRunning() queues. */
  async startLongRun(sec = 20) {
    await this.send(`!sleep ${sec}`);
    // Until a tool runs, a mid-run message preempts at once.
    // On the full target the run first waits for a ready sandbox pod, which can be a cold boot.
    await expect(this.page.locator('[data-testid="provider-tool-running"]')).toBeVisible({
      timeout: process.env.E2E_TARGET === "full" ? 90_000 : 30_000,
    });
  }

  /** The durable queued-message rows (QUEUE_UPDATED-driven + optimistic). */
  queuedMessages(): Locator {
    return this.page.locator('[data-testid="queued-message"]');
  }
  /** Wait until the run-status bar is gone, which is the authoritative run-over signal
   *  (the reply text lands slightly before the terminal event). */
  async waitForIdle(timeout = 45_000) {
    await expect(this.page.locator('[data-testid="run-status-bar"]')).toHaveCount(0, { timeout });
  }

  /** Send a turn and wait for the reply to land and the run to end, without returning early
   *  when the run has not started yet. */
  // The full target's default budget covers a cold sandbox boot before the exec starts.
  async completeTurn(text: string, timeout = process.env.E2E_TARGET === "full" ? 120_000 : 60_000) {
    const before = await this.assistantMessages().count();
    await this.send(text);
    // The run must begin before waiting for it to end.
    await expect(this.page.locator('[data-testid="run-status-bar"]'))
      .toBeVisible({ timeout: 30_000 })
      .catch(() => {}); // a very fast turn may finish before we look; the count poll below covers it
    await expect
      .poll(async () => this.assistantMessages().count(), { timeout })
      .toBeGreaterThan(before);
    await this.waitForIdle(timeout);
  }

}

type Fixtures = {
  chat: Chat;
  /** Accumulates console errors for the no-error assertion. */
  consoleErrors: string[];
  /** Auto: wipes server and client conversation state before each test so the shared
   *  webServer does not leak conversations between tests. */
  cleanState: void;
  /** Auto: forwards browser telemetry spans to the test output (E2E_TELEMETRY=1). */
  telemetryForwarding: void;
};

export const test = base.extend<Fixtures>({
  // A fresh connection per call, so a call after a long wait never lands on a socket
  // the server already closed (see support/apiRequest.mjs).
  request: async ({ playwright, baseURL, extraHTTPHeaders, httpCredentials, ignoreHTTPSErrors, userAgent }, use) => {
    const ctx = await newApiRequestContext(playwright.request, {
      baseURL,
      extraHTTPHeaders,
      httpCredentials,
      ignoreHTTPSErrors,
      userAgent,
    });
    await use(ctx);
    await ctx.dispose();
  },

  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
      // Forward telemetry spans to the test output when E2E_TELEMETRY=1.
      if (process.env.E2E_TELEMETRY === "1" && m.text().startsWith("scooter.span")) {
        // eslint-disable-next-line no-console
        console.log(`  [browser] ${m.text()}`);
      }
    });
    page.on("pageerror", (e) => errors.push(String(e)));
    await use(errors);
  },

  // Forwards telemetry spans to the test output when E2E_TELEMETRY=1; auto:true because a
  // Playwright fixture only instantiates when a test destructures it.
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

  // Runs before every test: the e2e webServer is one long-lived agent-host whose
  // conversation list persists, so each test needs a reset.
  cleanState: [
    async ({ request, context, baseURL }, use) => {
      const base = baseURL ?? "http://localhost:5173";
      // This fixture deletes every conversation, so two gates protect live deployments:
      // RUN_LIVE_E2E=1 skips the wipe, and a non-localhost baseURL fails hard.
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);
      if (process.env.RUN_LIVE_E2E === "1") {
        await use(); // live target: no wipe
        return;
      }
      if (!isLocal) {
        throw new Error(
          `REFUSING to wipe conversations on a non-local target (${base}). The cleanState fixture ` +
            `deletes EVERY conversation and must never touch a live deployment. Set RUN_LIVE_E2E=1 ` +
            `for live runs (which skips the wipe entirely).`,
        );
      }
      // 1. Server: delete every known conversation, then poll until the list is actually
      //    empty, because the destroy is async server-side.
      // The full target gets more attempts because a suspended conversation must be hydrated
      // before it can be ended.
      const attempts = process.env.E2E_TARGET === "full" ? 150 : 50;
      // scope=all: a named caller's "mine" list hides unowned leftovers.
      const listURL = `${base}/conversations?scope=all`;
      for (let i = 0; i < attempts; i++) {
        const res = await request.get(listURL);
        if (!res.ok()) {
          // Fast: the single-process server is down, so there is nothing to wipe.
          if (process.env.E2E_TARGET !== "full") break;
          // Full: the router 502s the list when every upstream momentarily fails, so retry
          // instead of skipping the wipe.
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        const convs = (await res.json()) as Array<{ id: string; starred?: boolean }>;
        if (convs.length === 0) {
          // Fast: one empty read from the single agent-host process is authoritative.
          if (process.env.E2E_TARGET !== "full") break;
          // Full: the router's aggregated list can omit a skipped pod's rows, so require three
          // consecutive empty reads before trusting it.
          let stable = true;
          for (let k = 0; k < 3; k++) {
            await new Promise((r) => setTimeout(r, 1000));
            const again = await request.get(listURL);
            if (!again.ok()) continue; // a transient read error is not evidence of a dirty slate
            const rows = (await again.json()) as Array<{ id: string }>;
            if (rows.length > 0) {
              stable = false;
              break;
            }
          }
          if (stable) break;
          continue; // rows resurfaced; back into the delete pass
        }
        await Promise.all(
          convs.map(async (c) => {
            // Unstar first, since DELETE returns 409 on a starred conversation; on full the
            // aggregated list can stale the flag, so unstar unconditionally.
            if (c.starred || process.env.E2E_TARGET === "full") {
              await request
                .patch(`${base}/conversations/${c.id}/starred`, { data: { starred: false } })
                .catch(() => undefined);
            }
            const del = await request.delete(`${base}/conversations/${c.id}`);
            // A 409 means it was still starred when the DELETE landed, so unstar again and retry once.
            if (del.status() === 409) {
              await request
                .patch(`${base}/conversations/${c.id}/starred`, { data: { starred: false } })
                .catch(() => undefined);
              return request.delete(`${base}/conversations/${c.id}`);
            }
            return del;
          }),
        );
        // Full waits 1s between passes because a destroy can keep the row listed for several
        // seconds after a 204.
        await new Promise((r) => setTimeout(r, process.env.E2E_TARGET === "full" ? 1000 : 100));
        // Fail loudly on the last iteration rather than hand the next test a dirty slate.
        if (i === attempts - 1) {
          const left = (await (await request.get(listURL)).json()) as Array<{
            id: string;
            starred?: boolean;
            title?: string;
          }>;
          if (left.length) {
            throw new Error(
              `cleanState could not empty the server after ${attempts} attempts. Still present: ` +
                left.map((c) => `${c.id}${c.starred ? " (STARRED — DELETE 409s)" : ""}`).join(", ") +
                `. State persists at LOCAL_STATE_PATH (default /tmp/agent-host-e2e), so this survives ` +
                `restarts until that directory is cleared.`,
            );
          }
        }
      }
      // Let the server settle after the destroys so the next test's first prompt starts clean.
      await new Promise((r) => setTimeout(r, 300));
      // 2. Client: clear persisted sessions on the origin via a throwaway page, then give
      //    its SSE connection a beat to tear down.
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

/** After every test: assert the UI surfaced no error. */
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
 * Fill a text input and verify the text landed, re-filling if the autoFocus composer stole
 * focus and swallowed the keystrokes.
 */
export async function fillStable(input: Locator, value: string, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (let attempt = 1; ; attempt++) {
    await input.fill(value);
    try {
      await expect(input).toHaveValue(value, { timeout: 2_000 });
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(
          `fillStable: "${value}" never stuck in ${await input.evaluate((el) => el.outerHTML).catch(() => "<input>")} ` +
            `after ${attempt} attempts — focus is being stolen (check for an autoFocus composer).\n${String(err)}`,
        );
      }
      await input.page().waitForTimeout(250);
    }
  }
}

/**
 * Seed a conversation owned by `user` (null = unowned) through the conversation router, the
 * way the ingress would (x-auth-user), and return the server-minted id; the title does not
 * survive the router path, so callers locate sidebar rows by `[data-conversation-id]`.
 */
export async function seedConversation(
  request: APIRequestContext,
  base: string,
  user: string | null,
  title: string,
): Promise<string> {
  const headers: Record<string, string> = user ? { "x-auth-user": user } : {};
  const r = await request.post(`${base}/conversations`, { data: { title }, headers });
  expect(r.ok(), `seed POST /conversations failed: ${r.status()}`).toBeTruthy();
  const { id } = (await r.json()) as { id: string };
  // Adoption on a cluster can lag under load, so 45s is a ceiling; the fast stack passes on
  // the first iteration.
  await expect
    .poll(
      async () => {
        // Hydrate-if-absent makes some pod adopt the CR so it becomes listable.
        await request.get(`${base}/conversations/${id}`, { headers }).catch(() => undefined);
        // The anonymous list sees every conversation regardless of owner.
        const list = await request.get(`${base}/conversations`);
        if (!list.ok()) return false;
        const rows = (await list.json()) as Array<{ id: string }>;
        return rows.some((c) => c.id === id);
      },
      { timeout: 45_000, intervals: [500, 1_000] },
    )
    .toBe(true);
  await request
    .patch(`${base}/conversations/${id}/title`, { data: { title }, headers })
    .catch(() => undefined);
  return id;
}

/**
 * A whole-UI state snapshot: every surface that can independently go wrong, read in one pass.
 * Asserting invariants between surfaces catches cross-component divergence (thread, queue,
 * run-status bar and sidebar disagreeing at the same instant) that a single-fact assertion
 * passes straight through.
 */
export interface UiSnapshot {
  /** Whether the chat view is mounted (composer present); the chat-view invariants do not apply on the settings page. */
  chatMounted: boolean;
  // thread
  userMessages: number;
  assistantMessages: number;
  toolCards: number;
  lastUserText: string;
  // run state
  running: boolean;          // the run-status bar is up
  composerSendable: boolean; // the Send button is offered (idle)
  composerStop: boolean;
  runError: string | null;
  authError: boolean;
  // queue
  queued: string[];          // queued row texts, in render order
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

/** Read every UI surface at one instant; a missing element reads as null/0/false so a snapshot is always comparable. */
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
    // textContent, not innerText: an off-screen content-visibility:auto bubble has an empty innerText.
    lastUserText: nUsers ? ((await users.nth(nUsers - 1).textContent().catch(() => "")) || "").trim() : "",
    // One evaluate keeps the run-state triple mutually consistent, and the composer's send
    // button is targeted precisely because sidebar row buttons can also match /send/i.
    ...(await page.evaluate(() => {
      // Mirrors Playwright's isVisible(): first match, non-empty box, not visibility:hidden.
      const vis = (s: string): boolean => {
        const el = document.querySelector(s);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
        return getComputedStyle(el).visibility !== "hidden";
      };
      return {
        running: vis('[data-testid="run-status-bar"]'),
        composerSendable: vis('.aui-composer-send, [aria-label="Send message"]'),
        composerStop: vis('[data-testid="composer-stop"]'),
      };
    })),
    runError: await text('[data-testid="run-error-message"]'),
    authError: await visible('[data-testid="stream-auth-error-bar"]'),
    // One evaluate keeps the inline queued rows and selected tab mutually consistent.
    ...(await page.evaluate(() => {
      return {
        queued: Array.from(document.querySelectorAll('[data-testid="queued-message-text"]'))
          .map((e) => (e.textContent || "").trim()),
        selectedTab:
          document
            .querySelector('[data-testid^="right-panel-tab-"][aria-selected="true"]')
            ?.getAttribute("data-testid") ?? null,
      };
    })),
    // One evaluate reads the panel and its option count from the same DOM state, since
    // InterruptPanel cannot render empty.
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

/** The cross-component invariants that must hold at every instant; call it after every step of every test. */
export function assertConsistent(s: UiSnapshot, when: string) {
  // These are chat-view invariants, so a non-chat view such as the settings page has nothing to check.
  if (!s.chatMounted) return;
  // Send and Stop are the same control in two states, never both.
  expect(s.composerSendable && s.composerStop, `${when}: composer shows BOTH Send and Stop`).toBe(false);
  // The composer stays submittable during a run (a mid-run message is queued), so the only
  // running-state invariant is that an idle app must not show Stop.
  if (!s.running) {
    expect(s.composerStop, `${when}: no run in flight but the composer still shows Stop`).toBe(false);
  }
  // A terminal error and an in-flight run are mutually exclusive states.
  if (s.runError) {
    expect(s.running, `${when}: showing a terminal run error WHILE claiming to run`).toBe(false);
  }
  // An interrupt panel with no options is un-answerable.
  if (s.interruptOpen) {
    expect(s.interruptOptions, `${when}: interrupt panel open with NO options (un-answerable)`).toBeGreaterThan(0);
  }
  // Every queued row must carry text; a blank row means the queue rendered without its content.
  for (const q of s.queued) {
    expect(q.length, `${when}: a queued row rendered EMPTY`).toBeGreaterThan(0);
  }
}

/** Cross-check the sidebar against the server's conversation list to catch a UI that has silently detached from reality. */
export async function assertMatchesServer(
  page: Page,
  request: APIRequestContext,
  baseURL: string | undefined,
  when: string,
) {
  const base = baseURL ?? "http://localhost:5173";
  const res = await request.get(`${base}/conversations`);
  if (!res.ok()) return; // server not reachable for this stack; skip rather than fail spuriously
  const convs = (await res.json()) as Array<{ id: string }>;

  // Compare ids, not counts; a row pending creation ("+ New conversation") is local-only until
  // the first prompt and is expected to be absent server-side.
  const rows = await page.locator('[data-testid="session-item"]').evaluateAll((els) =>
    els.map((el) => ({
      id: el.getAttribute("data-conversation-id") ?? "",  // the server id; absent while pending
      pending: el.getAttribute("data-pending-create") === "true",
      active: el.getAttribute("data-active") === "true",
    })),
  );
  const serverIds = new Set(convs.map((c) => c.id));
  let missing = rows.filter((r) => !r.pending && !serverIds.has(r.id)).map((r) => r.id);
  const notShown = convs.filter((c) => !rows.some((r) => r.id === c.id)).map((c) => c.id);

  // Full: the sidebar lists the whole shared fleet and other specs' cleanState deletes are
  // normal traffic, so only the active row (this test's own conversation) is judged.
  if (process.env.E2E_TARGET === "full") {
    const own = new Set(rows.filter((r) => r.active).map((r) => r.id));
    missing = missing.filter((id) => own.has(id));
  }

  let confirmed = missing;
  if (confirmed.length && process.env.E2E_TARGET === "full") {
    // Full: the router's aggregate can be degraded across a pod's readiness gap, so an id is
    // only confirmed missing if it was absent from every successful re-read.
    let goodReads = 0;
    for (let i = 0; i < 20 && confirmed.length; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const again = await request.get(`${base}/conversations`);
      if (!again.ok()) continue;
      goodReads++;
      const ids = new Set(((await again.json()) as Array<{ id: string }>).map((c) => c.id));
      confirmed = confirmed.filter((id) => !ids.has(id));
    }
    // Never fail on the strength of zero usable reads.
    if (goodReads === 0) confirmed = [];
  }
  expect(
    confirmed,
    `${when}: sidebar shows conversation(s) the server does not have: ${confirmed.join(", ")}`,
  ).toEqual([]);
  // Fast only: on the full target the server holds other specs' rows and the sidebar shows
  // the user's own scope, so this direction only holds on the single-process wiped stack.
  if (process.env.E2E_TARGET !== "full") {
    expect(
      notShown,
      `${when}: server has conversation(s) the sidebar does not show: ${notShown.join(", ")}`,
    ).toEqual([]);
  }
  // At most one unsent "New chat" can be pending at a time.
  expect(
    rows.filter((r) => r.pending).length,
    `${when}: more than one uncreated conversation in the sidebar`,
  ).toBeLessThanOrEqual(1);
}

/** Where step screenshots land; each shot carries a monotonic index so the sequence reads in order. */
const SHOT_DIR = process.env.UI_SHOT_DIR ?? "test-results/ui-timeline";
let shotSeq = 0;

/** Capture the UI at this instant, named for the step, when UI_SHOTS=1; a failed capture never fails the test. */
export async function shot(page: Page, when: string): Promise<void> {
  if (process.env.UI_SHOTS !== "1") return;
  const safe = when.replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
  const idx = String(++shotSeq).padStart(3, "0");
  await page
    .screenshot({ path: `${SHOT_DIR}/${idx}-${safe}.png`, fullPage: false })
    .catch(() => {});
}

/** snapshot + assertConsistent + a screenshot in one call, capturing the shot before asserting so a failing step still leaves an image. */
export async function checkpoint(page: Page, when: string): Promise<UiSnapshot> {
  const s = await snapshot(page);
  await shot(page, when);
  assertConsistent(s, when);
  return s;
}
