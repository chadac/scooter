/**
 * Tier 3 E2E for the conversation subpage, `/chat/<id>`: one conversation's thread, composer
 * and approvals, with no sidebar and no right panel, which a sandbox embeds beside its own
 * service and the main header pops out. This pins the route and what it shows; who may frame
 * it is nginx's job and is checked against the rendered config (services/ui/image/check.nix).
 */

import { test, expect, seedConversation } from "./fixtures.js";
import { fastOnly } from "./target.js";

const SESSIONS_KEY = "kubenix-agent.sessions.v1";

const chatPage = {
  root: '[data-testid="chat-page"]',
  openApp: '[data-testid="chat-page-open-app"]',
  approvals: '[data-testid="chat-page-approvals"]',
  notFound: '[data-testid="chat-page-not-found"]',
};

/** Every conversation id the server lists. */
async function conversationIds(request: import("@playwright/test").APIRequestContext, base: string) {
  const res = await request.get(`${base}/conversations`);
  return res.ok() ? ((await res.json()) as Array<{ id: string }>).map((r) => r.id) : [];
}

/** The main app's saved list once its open conversation's turn has ended and been seen. */
async function settledSessions(page: import("@playwright/test").Page): Promise<string> {
  let saved = "";
  // lastReplyAt and lastSeenAt are saved after the reply shows.
  await expect
    .poll(async () => {
      saved = await page.evaluate((k) => localStorage.getItem(k) ?? "", SESSIONS_KEY);
      const st = JSON.parse(saved || "{}") as {
        currentId?: string;
        sessions?: Array<{ id: string; runStartedAt?: number; lastReplyAt?: number; lastSeenAt?: number }>;
      };
      const cur = st.sessions?.find((s) => s.id === st.currentId);
      return cur !== undefined && cur.runStartedAt === undefined && cur.lastReplyAt !== undefined && cur.lastSeenAt === cur.lastReplyAt;
    }, { timeout: 20_000 })
    .toBe(true);
  return saved;
}

// fastOnly: raising an approval and answering can-approve need the fast stack's open routes.
fastOnly("raises an approval through the open approvals route and fakes can-approve")("conversation subpage /chat/<id>", () => {
  test.beforeEach(() => test.setTimeout(120_000));

  test("shows only that conversation, and a message sent there lands in it", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    const id = await seedConversation(request, base, null, "Subpage target");

    await page.goto(`/chat/${id}`);
    await expect(page.locator(chatPage.root)).toHaveAttribute("data-conversation-id", id);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    // No sidebar, no right panel, no settings: the chat and nothing else.
    await expect(page.locator('[data-testid="session-item"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="right-panel"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="settings-toggle"]')).toHaveCount(0);

    // "Open in Scooter" leaves a host's iframe for the full app on this conversation.
    const openApp = page.locator(chatPage.openApp);
    await expect(openApp).toHaveAttribute("href", `/?thread=${id}`);
    await expect(openApp).toHaveAttribute("target", "_top");

    // A send goes to THIS conversation, never a new one.
    const before = await conversationIds(request, base);
    await chat.sendTurn("hello from the subpage");
    await expect(chat.userMessages().filter({ hasText: "hello from the subpage" })).toBeVisible();
    expect((await conversationIds(request, base)).filter((c) => !before.includes(c))).toEqual([]);

    // The full app shows the same message on the same conversation.
    await page.goto(`/?thread=${id}`);
    await expect(chat.userMessages().filter({ hasText: "hello from the subpage" })).toBeVisible({ timeout: 20_000 });
  });

  test("leaves the main app's saved conversation list alone", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    const id = await seedConversation(request, base, null, "Subpage storage");

    await chat.open();
    await chat.sendTurn("main app conversation");
    const saved = await settledSessions(page);

    // The subpage shares localStorage with the app (same origin), and must not write to it.
    await page.goto(`/chat/${id}`);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(1_000);
    expect(await page.evaluate((k) => localStorage.getItem(k), SESSIONS_KEY)).toBe(saved);
  });

  test("shows pending approvals above the thread", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    const id = await seedConversation(request, base, null, "Subpage approvals");
    await page.route("**/can-approve", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ canApprove: true }) }),
    );

    await page.goto(`/chat/${id}`);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    const res = await request.post(`${base}/conversations/${id}/approvals/echo`, {
      headers: { "Content-Type": "application/json" },
      data: { request_id: `sub-${Date.now()}`, message: "Echo wants a yes from the subpage." },
    });
    expect(res.status()).toBe(202);

    const approvals = page.locator(chatPage.approvals);
    await expect(approvals).toBeVisible({ timeout: 30_000 });
    await expect(approvals.locator('[data-testid="interrupt-message"]')).toContainText("Echo wants a yes from the subpage.");
  });

  test("an unknown conversation says so, with no composer to start one", async ({ chat, page }) => {
    await page.goto("/chat/00000000-0000-4000-8000-00000000dead");
    await expect(page.locator(chatPage.notFound)).toBeVisible({ timeout: 20_000 });
    await expect(chat.input()).toHaveCount(0);
  });

  test("the main header pops the chat out into its own window", async ({ chat, page, baseURL, request }) => {
    const base = (baseURL ?? "").replace(/\/$/, "");
    const id = await seedConversation(request, base, null, "Subpage pop-out");
    await page.goto(`/?thread=${id}`);
    await expect(chat.input()).toBeVisible({ timeout: 20_000 });

    const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator('[data-testid="pop-out-chat"]').click()]);
    await expect.poll(() => new URL(popup.url()).pathname).toBe(`/chat/${id}`);
    await expect(popup.locator(chatPage.root)).toHaveAttribute("data-conversation-id", id);
  });
});
