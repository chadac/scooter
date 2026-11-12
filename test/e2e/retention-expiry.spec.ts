/** E2E: a conversation near its retention lifetime says when it will be deleted. */

import { test, expect, seedConversation } from "./fixtures.js";

test.describe("retention expiry hint", () => {
  test.setTimeout(90_000);

  test("a conversation in a 1-day folder shows its time left, and a forever folder clears it", async ({ chat, page, request, baseURL }) => {
    const base = baseURL ?? "http://localhost:5173";
    const id = await seedConversation(request, base, null, `Expiring ${Date.now()}`);
    const folder = ((await (await request.post(`${base}/folders`, { data: { name: `e2e-expiry-${Date.now()}` } })).json()) as { id: string }).id;
    await request.patch(`${base}/folders/${folder}`, { data: { conversationLifetimeHours: 24 } });
    await request.put(`${base}/conversations/${id}/folder`, { data: { folderId: folder } });

    await page.setViewportSize({ width: 1280, height: 900 });
    await chat.open();
    const row = page.locator(`[data-testid="session-item"][data-conversation-id="${id}"]`);
    const hint = row.getByTestId("session-expiry");
    // Within a day of a 1-day lifetime is inside the warning window.
    await expect(hint).toHaveText(/^(23h|1d)$/, { timeout: 30_000 });
    await expect(hint).toHaveAttribute("title", /retention/);

    // A forever folder clears it.
    await request.patch(`${base}/folders/${folder}`, { data: { conversationLifetimeHours: 0 } });
    await page.reload();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(hint).toHaveCount(0);

    await request.delete(`${base}/folders/${folder}`);
  });
});
