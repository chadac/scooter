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

  /** Wait for an assistant reply containing `re` (default: any non-empty). */
  async waitForReply(re: RegExp = /\S/, timeout = 30_000) {
    await expect(this.page.getByText(re).first()).toBeVisible({ timeout });
  }
}

type Fixtures = {
  chat: Chat;
  /** Accumulates console errors for the no-error assertion. */
  consoleErrors: string[];
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
