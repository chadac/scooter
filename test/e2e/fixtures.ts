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

import { test as base, expect, type Page, type Locator } from "@playwright/test";

export const sel = {
  errorBox: ".aui-message-error-root",
  userMessage: ".aui-user-message-content",
  assistantMessage: ".aui-assistant-message-content, .aui-md", // styled content
  // Tool calls render inside a collapsible group; fallback shows when expanded.
  toolCall: ".aui-tool-group-root, .aui-tool-fallback-root",
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

  /** Wait for an assistant reply containing `re` (default: any non-empty).
   *  Generous timeout: a freshly-created conversation lazily spawns its bridge
   *  on the first prompt, so the very first reply can be slower than later ones. */
  async waitForReply(re: RegExp = /\S/, timeout = 45_000) {
    await expect(this.page.getByText(re).first()).toBeVisible({ timeout });
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
